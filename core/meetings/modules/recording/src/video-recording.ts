import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import http from 'http';
import https from 'https';
import { log } from './log';

/**
 * Hardware acceleration modes for video encoding.
 * Controlled via VIDEO_HWACCEL env var (default: 'none').
 *   none  — software encoding (libvpx-vp9 → webm). Works everywhere.
 *   vaapi — Intel iGPU / AMD via VA-API (h264_vaapi → mp4). Requires /dev/dri passthrough.
 *   nvenc — NVIDIA via NVENC (h264_nvenc → mp4). Requires nvidia runtime.
 */
export type VideoHwAccel = 'none' | 'vaapi' | 'nvenc';

/**
 * Where the frames come from.
 *   screencast — CDP Page.startScreencast frames pushed in by the host, paced to CFR here.
 *   x11grab    — ffmpeg reads the Xvfb display directly.
 *
 * screencast is the only source that works when the bot attaches over CDP to a
 * shared session browser: the page renders on THAT container's display, so the
 * bot's own :99 is blank. It is also per-tab, so a shared browser's other tabs
 * never bleed into the recording.
 */
export type VideoFrameSource = 'screencast' | 'x11grab';

/**
 * Receives the encoded byte stream in order, split into recording.v1 chunks.
 *
 * Splitting is by BYTE COUNT, not by frame or fragment: concatenating the parts in seq order
 * reproduces ffmpeg's output exactly, whatever the boundaries. The container is what makes a
 * PARTIAL concatenation useful — fragmented mp4 keeps the header up front and each fragment
 * self-describing, so any prefix is playable and a bot that dies mid-meeting still leaves
 * something watchable.
 *
 * The last call is always an EMPTY chunk with isFinal=true — recording.v1's COMPLETED signal,
 * matching what the audio tap sends.
 */
export type VideoChunkSink = (seq: number, isFinal: boolean, bytes: Buffer) => void;

export interface FramePacerDeps {
  /** Target constant frame rate. Video duration is exactly framesWritten / fps. */
  fps: number;
  /** Write one frame to the sink. Returns false when the sink is backpressured. */
  write: (frame: Buffer) => boolean;
  /** Injectable clock, so pacing is provable without real time passing. */
  now?: () => number;
  /** Cap on frames written in a single tick, so a long stall can't block the event loop. */
  maxBurst?: number;
}

/**
 * Paces irregular screencast frames into a constant-rate stream.
 *
 * Page.screencastFrame fires on visual CHANGE, not at a fixed rate. Feeding those
 * arrivals straight into `image2pipe -framerate N` would make ffmpeg assume N fps
 * regardless, so a static three-minute stretch would collapse into a couple of
 * seconds and the file's timeline would silently decouple from the wall clock.
 * DNA derives every clip offset as `segment_wall_time - recording_t0`, so any such
 * drift puts clips on the wrong shot.
 *
 * So the pacer holds the LATEST frame and, on each tick, writes however many copies
 * the wall clock says should exist by now. The invariant it maintains is:
 *
 *     framesWritten === floor(elapsedMs * fps / 1000)
 *
 * which makes video time identical to wall time by construction, and is
 * self-correcting across timer drift, GC pauses and a stalled screencast.
 *
 * Backpressure never drops frames. A `false` from write() means the stream's buffer
 * is filling, not that the frame was rejected — Node still queues it — so the count
 * advances and we simply stop writing until 'drain'. Dropping instead would shorten
 * the video and break the invariant above, which is the whole point of this class.
 * The duplicate frames all reference one Buffer, so a deficit costs O(1) memory.
 */
export class FramePacer {
  private latest: Buffer | null = null;
  private written = 0;
  private startedAt = 0;
  private blocked = false;
  private running = false;
  private readonly now: () => number;
  private readonly maxBurst: number;

  constructor(private deps: FramePacerDeps) {
    this.now = deps.now ?? Date.now;
    this.maxBurst = deps.maxBurst ?? Math.max(1, deps.fps * 2);
  }

  /**
   * Begin the timeline. Deliberately takes no frame: the meeting UI may not have
   * painted yet, and a synthesized placeholder would have to match the screencast's
   * eventual dimensions or image2pipe would choke on the resolution change. Instead
   * the clock starts here and the first real frame back-fills whatever it owes.
   */
  start(atMs?: number): void {
    this.startedAt = atMs ?? this.now();
    this.written = 0;
    this.blocked = false;
    this.running = true;
  }

  /** Record the newest frame. Writing is the tick's job, never the arrival's. */
  push(frame: Buffer): void {
    this.latest = frame;
  }

  /** How many frames the wall clock says should exist by now. */
  private expected(): number {
    return Math.floor(((this.now() - this.startedAt) * this.deps.fps) / 1000);
  }

  /** Emit whatever the wall clock owes, up to maxBurst. Stops on backpressure. */
  tick(): void {
    if (!this.running || this.blocked || this.latest === null) return;
    const budget = Math.min(this.expected() - this.written, this.maxBurst);
    for (let i = 0; i < budget; i++) {
      const accepted = this.deps.write(this.latest);
      this.written++;
      if (!accepted) {
        this.blocked = true;
        return;
      }
    }
  }

  /** The sink drained — resume, and immediately work off whatever accrued. */
  onDrain(): void {
    this.blocked = false;
    this.tick();
  }

  stop(): void {
    this.running = false;
  }

  get framesWritten(): number {
    return this.written;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }
}

/**
 * VideoRecordingService encodes a meeting to a video file.
 *
 * Frames arrive either from CDP screencast (pushed in via pushFrame, paced to CFR
 * by FramePacer) or from ffmpeg reading the Xvfb display directly. The host owns
 * the CDP session and the browser handle; this class only ever sees JPEG buffers.
 *
 * Usage (screencast):
 *   const svc = new VideoRecordingService(meetingId, sessionUid);
 *   svc.start();
 *   // ... host acks each Page.screencastFrame and calls svc.pushFrame(jpeg) ...
 *   await svc.stop();
 *   await svc.upload(uploadUrl, token);
 *   await svc.cleanup();
 */
export class VideoRecordingService {
  private filePath: string;
  private format: string;
  private ffmpegProcess: ChildProcess | null = null;
  private isRunning = false;
  private startTime = 0;
  private display: string;
  private hwaccel: VideoHwAccel;
  private encodeH264: boolean;
  private source: VideoFrameSource;
  private fps: number;
  private pacer: FramePacer | null = null;
  private pacerTimer: NodeJS.Timeout | null = null;
  private onChunk: VideoChunkSink | null = null;
  private chunkBytes: number;
  private chunkMs: number;
  private chunkTimer: NodeJS.Timeout | null = null;
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private chunkSeq = 0;
  private finalEmitted = false;

  constructor(
    private meetingId: number,
    private sessionUid: string,
    onChunk?: VideoChunkSink,
  ) {
    this.onChunk = onChunk ?? null;
    this.chunkBytes = Number(process.env.VEXA_VIDEO_CHUNK_BYTES) || 4 * 1024 * 1024;
    // A SIZE threshold alone does not bound how much is at risk: a near-static meeting screen
    // encodes to very little, so 4 MB can take minutes to accumulate and a crash loses all of it.
    // Flushing on a clock too bounds the exposure in TIME, matching the audio tap's timeslice.
    this.chunkMs = Number(process.env.VEXA_VIDEO_CHUNK_MS) || 15_000;
    this.display = process.env.DISPLAY || ':99';
    this.hwaccel = (process.env.VIDEO_HWACCEL || 'none').toLowerCase() as VideoHwAccel;
    this.encodeH264 = process.env.ENCODE_H264 === 'true';
    this.source = (process.env.VEXA_VIDEO_SOURCE || 'screencast').toLowerCase() as VideoFrameSource;
    this.fps = Number(process.env.VEXA_VIDEO_FPS) || 5;
    // Screencast always encodes h264 into fragmented mp4: every prefix of a fragmented
    // file is playable, so chunked upload concatenates cleanly and a bot that dies
    // mid-meeting still leaves a usable recording.
    this.format = this.source === 'screencast' || this.hwaccel !== 'none' || this.encodeH264 ? 'mp4' : 'webm';
    this.filePath = path.join('/tmp', `video_recording_${meetingId}_${sessionUid}.${this.format}`);
  }

  start(): void {
    if (this.isRunning) {
      log('[VideoRecording] Already running');
      return;
    }

    const args = this.buildFfmpegArgs();
    log(`[VideoRecording] Starting ffmpeg (source=${this.source}, fps=${this.fps}, hwaccel=${this.hwaccel}): ffmpeg ${args.join(' ')}`);

    this.ffmpegProcess = spawn('ffmpeg', args, {
      stdio: [this.source === 'screencast' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    this.isRunning = true;
    this.startTime = Date.now();

    if (this.source === 'screencast') {
      const stdin = this.ffmpegProcess.stdin!;
      // EPIPE arrives here if ffmpeg dies first; swallow it so a video fault never
      // takes down the meeting.
      stdin.on('error', (err: Error) => log(`[VideoRecording] stdin error: ${err.message}`));
      this.pacer = new FramePacer({ fps: this.fps, write: (frame) => stdin.write(frame) });
      this.pacer.start(this.startTime);
      stdin.on('drain', () => this.pacer?.onDrain());
      this.pacerTimer = setInterval(() => this.pacer?.tick(), Math.max(1, Math.round(1000 / this.fps)));
    }

    // Streaming mode: ffmpeg writes the encoded file to stdout and we cut it into chunks as it
    // arrives, so every finished part is durable before the meeting ends. Nothing is buffered to
    // disk, so a SIGKILL loses at most the tail below the chunk threshold.
    if (this.onChunk) {
      this.ffmpegProcess.stdout?.on('data', (buf: Buffer) => this.absorb(buf));
      this.chunkTimer = setInterval(() => this.flushPartial(), this.chunkMs);
    }

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      // ffmpeg writes progress to stderr; only log errors
      const text = data.toString().trim();
      if (text.includes('Error') || text.includes('error') || text.includes('failed')) {
        log(`[VideoRecording] ffmpeg: ${text}`);
      }
    });

    this.ffmpegProcess.on('exit', (code) => {
      this.isRunning = false;
      log(`[VideoRecording] ffmpeg exited with code ${code}`);
    });

    this.ffmpegProcess.on('error', (err) => {
      this.isRunning = false;
      log(`[VideoRecording] ffmpeg spawn error: ${err.message}`);
    });
  }

  /**
   * Hand the newest screencast frame to the pacer. Cheap and synchronous by design:
   * the host calls this straight from the CDP event handler, and the pacer decides
   * when bytes actually reach ffmpeg.
   */
  pushFrame(jpeg: Buffer): void {
    this.pacer?.push(jpeg);
  }

  /** Accumulate encoded bytes and emit whole chunks as the threshold is crossed. */
  private absorb(buf: Buffer): void {
    this.pending.push(buf);
    this.pendingLen += buf.length;
    while (this.pendingLen >= this.chunkBytes) {
      const joined = Buffer.concat(this.pending, this.pendingLen);
      const take = joined.subarray(0, this.chunkBytes);
      const rest = joined.subarray(this.chunkBytes);
      this.pending = rest.length ? [rest] : [];
      this.pendingLen = rest.length;
      this.emit(take, false);
    }
  }

  /**
   * Emit whatever is buffered as a chunk, if anything. Driven by the clock so the amount of
   * unflushed video stays time-bounded regardless of bitrate. A no-op when nothing is pending —
   * emitting an empty DATA chunk would waste a seq and upload zero bytes.
   */
  private flushPartial(): void {
    if (this.finalEmitted || this.pendingLen === 0) return;
    const bytes = Buffer.concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    this.emit(bytes, false);
  }

  /** Flush whatever is buffered, then the empty COMPLETED signal — exactly once. */
  private flushFinal(): void {
    if (this.finalEmitted) return;
    if (this.pendingLen > 0) {
      this.emit(Buffer.concat(this.pending, this.pendingLen), false);
      this.pending = [];
      this.pendingLen = 0;
    }
    this.finalEmitted = true;
    this.emit(Buffer.alloc(0), true);
  }

  private emit(bytes: Buffer, isFinal: boolean): void {
    const seq = this.chunkSeq++;
    try {
      this.onChunk?.(seq, isFinal, bytes);
    } catch (err: any) {
      // A sink failure must never propagate into ffmpeg's data handler.
      log(`[VideoRecording] chunk ${seq} sink threw: ${err?.message ?? String(err)}`);
    }
  }

  /**
   * Stop recording and return the path to the finished file.
   *
   * For screencast the clean shutdown is closing stdin: ffmpeg sees end-of-input,
   * flushes and finalizes on its own. SIGTERM is only the fallback for a wedged
   * process — sending it first would risk a truncated file.
   */
  stop(): Promise<string> {
    if (this.pacerTimer) {
      clearInterval(this.pacerTimer);
      this.pacerTimer = null;
    }
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    this.pacer?.stop();

    if (!this.ffmpegProcess || !this.isRunning) {
      this.flushFinal();
      return Promise.resolve(this.filePath);
    }

    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(termTimer);
        clearTimeout(forceKillTimer);
        // Flush AFTER exit: ffmpeg writes the trailing fragment as it finalizes, and stdout's
        // last 'data' lands before 'exit'. Flushing earlier would cut off the tail and, worse,
        // send the COMPLETED signal before the final bytes.
        this.flushFinal();
        log(`[VideoRecording] ffmpeg stopped gracefully (${this.pacer?.framesWritten ?? 0} frames, ${this.chunkSeq} chunks)`);
        resolve(this.filePath);
      };

      this.ffmpegProcess!.once('exit', onExit);

      if (this.source === 'screencast') {
        this.ffmpegProcess!.stdin?.end();
      } else {
        this.ffmpegProcess!.kill('SIGTERM');
      }

      // Escalate only if closing stdin wasn't enough.
      const termTimer = setTimeout(() => {
        log('[VideoRecording] ffmpeg still running after stdin close, sending SIGTERM');
        this.ffmpegProcess?.kill('SIGTERM');
      }, 10000);

      const forceKillTimer = setTimeout(() => {
        log('[VideoRecording] ffmpeg did not exit in time, sending SIGKILL');
        this.ffmpegProcess?.kill('SIGKILL');
        resolve(this.filePath);
      }, 25000);
    });
  }

  /** Frames handed to ffmpeg so far. Screencast only; 0 for x11grab. */
  /** recording.v1 chunks emitted so far, including the trailing COMPLETED signal. */
  getChunksEmitted(): number {
    return this.chunkSeq;
  }

  getFramesWritten(): number {
    return this.pacer?.framesWritten ?? 0;
  }

  /**
   * Upload the video file to the meeting-api upload endpoint.
   * Sends media_type: "video" so meeting-api stores it as a video MediaFile.
   */
  async upload(callbackUrl: string, token: string): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      log(`[VideoRecording] File not found for upload: ${this.filePath}`);
      return;
    }

    const fileData = await fs.promises.readFile(this.filePath);
    const fileStats = await fs.promises.stat(this.filePath);
    const durationSeconds = (Date.now() - this.startTime) / 1000;

    log(`[VideoRecording] Uploading ${fileStats.size} bytes (${durationSeconds.toFixed(1)}s) to ${callbackUrl}`);

    const boundary = `----VexaVideoRecording${Date.now()}`;
    const contentTypeMap: Record<string, string> = {
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      mp4: 'video/mp4',
    };
    const fileContentType = contentTypeMap[this.format] || 'video/webm';

    const metadata = JSON.stringify({
      meeting_id: this.meetingId,
      session_uid: this.sessionUid,
      media_type: 'video',
      format: this.format,
      duration_seconds: durationSeconds,
      file_size_bytes: fileStats.size,
      start_time_utc: this.startTime ? new Date(this.startTime).toISOString() : undefined,
    });

    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n`));
    parts.push(Buffer.from(metadata));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.${this.format}"\r\nContent-Type: ${fileContentType}\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const url = new URL(callbackUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
            'Authorization': `Bearer ${token}`,
          },
        },
        (res) => {
          let responseData = '';
          res.on('data', (chunk) => { responseData += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              log(`[VideoRecording] Upload successful: ${res.statusCode}`);
              resolve();
            } else {
              log(`[VideoRecording] Upload failed: ${res.statusCode} - ${responseData}`);
              reject(new Error(`Video upload failed with status ${res.statusCode}: ${responseData}`));
            }
          });
        }
      );
      req.on('error', (err) => {
        log(`[VideoRecording] Upload error: ${err.message}`);
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Mux an audio file into the video, producing a self-contained file.
   * Copies the video stream as-is and encodes audio (opus for webm, aac for mkv/mp4).
   * Replaces this.filePath with the muxed output.
   */
  /**
   * @param audioPath   Path to the finalized WAV file.
   * @param audioDelayMs  Delay (in ms) to apply to the audio stream.
   *   Positive = audio started later than video, so we pad silence at the start.
   *   This keeps audio and video in sync when they didn't start at the same time.
   */
  async muxAudio(audioPath: string, audioDelayMs: number = 0): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      log(`[VideoRecording] Video file not found for muxing: ${this.filePath}`);
      return;
    }
    if (!fs.existsSync(audioPath)) {
      log(`[VideoRecording] Audio file not found for muxing: ${audioPath}`);
      return;
    }

    const muxedPath = this.filePath.replace(`.${this.format}`, `_muxed.${this.format}`);
    const audioDelaySec = Math.max(0, audioDelayMs / 1000);

    // -itsoffset delays the audio input so it aligns with the video timeline.
    // Without this, audio that started later than video would play too early.
    const args = [
      '-y',
      '-i', this.filePath,
      ...(audioDelaySec > 0 ? ['-itsoffset', audioDelaySec.toFixed(3)] : []),
      '-i', audioPath,
      '-c:v', 'copy',
      // mp4 always re-encodes to aac: the audio tap emits Opus-in-webm, and while
      // Opus-in-mp4 is legal it does not play in Safari or QuickTime. webm can copy
      // an Opus input as-is, but WAV/PCM still has to be encoded for the container.
      '-c:a', this.format === 'mp4' ? 'aac' : (audioPath.endsWith('.wav') ? 'libopus' : 'copy'),
      '-shortest',
      muxedPath,
    ];

    log(`[VideoRecording] Muxing audio into video: ffmpeg ${args.join(' ')}`);

    return new Promise((resolve) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('exit', async (code) => {
        if (code === 0 && fs.existsSync(muxedPath)) {
          // Replace the original video-only file with the muxed one
          try {
            await fs.promises.unlink(this.filePath);
          } catch {}
          this.filePath = muxedPath;
          const stats = fs.statSync(muxedPath);
          log(`[VideoRecording] Muxed file ready: ${muxedPath} (${stats.size} bytes)`);
        } else {
          log(`[VideoRecording] Mux failed (code=${code}): ${stderr.slice(-500)}`);
          // Keep the original video-only file for upload
        }
        resolve();
      });
      proc.on('error', (err) => {
        log(`[VideoRecording] Mux spawn error: ${err.message}`);
        resolve();
      });
    });
  }

  async cleanup(): Promise<void> {
    try {
      if (fs.existsSync(this.filePath)) {
        await fs.promises.unlink(this.filePath);
        log(`[VideoRecording] Cleaned up ${this.filePath}`);
      }
    } catch (err: any) {
      log(`[VideoRecording] Cleanup error: ${err.message}`);
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  getStartTime(): number {
    return this.startTime;
  }

  // ---------------------------------------------------------------------------

  private buildFfmpegArgs(): string[] {
    if (this.source === 'screencast') return this.buildScreencastArgs();

    const fps = '10';
    const inputSize = '1920x1080';

    // Pre-input args (e.g. hwaccel flags that must appear before -i)
    let preInputArgs: string[] = [];
    let encoderArgs: string[];
    let outputFile: string;

    switch (this.hwaccel) {
      case 'vaapi': {
        // Intel iGPU / AMD Radeon via VA-API
        // Requires /dev/dri/renderD128 device in container
        encoderArgs = [
          '-vaapi_device', '/dev/dri/renderD128',
          '-vf', 'format=nv12,hwupload',
          '-c:v', 'h264_vaapi',
          '-qp', '28',
        ];
        outputFile = this.filePath; // .mp4
        break;
      }
      case 'nvenc': {
        // NVIDIA via NVENC — -hwaccel cuda must precede -i
        preInputArgs = ['-hwaccel', 'cuda'];
        encoderArgs = [
          '-c:v', 'h264_nvenc',
          '-cq', '28',
          '-preset', 'p2',
        ];
        outputFile = this.filePath; // .mp4
        break;
      }
      default: {
        if (this.encodeH264) {
          // CPU H.264 — universally supported including Safari
          encoderArgs = [
            '-c:v', 'libx264',
            '-crf', '28',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
          ];
        } else {
          // Software VP9 — excellent compression for screen content
          encoderArgs = [
            '-c:v', 'libvpx-vp9',
            '-pix_fmt', 'yuv420p', // VP9 profile 0 — required for Safari compatibility
            '-crf', '35',
            '-b:v', '0',
            '-deadline', 'realtime',
            '-cpu-used', '8',
            '-row-mt', '1',
          ];
        }
        outputFile = this.filePath; // .webm or .mp4
        break;
      }
    }

    // Common input: x11grab from the virtual display
    const inputArgs = [
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', fps,
      '-video_size', inputSize,
      '-i', this.display,
    ];

    return [
      '-y',         // overwrite output file if exists
      ...preInputArgs,
      ...inputArgs,
      ...encoderArgs,
      '-an',        // no audio (audio is muxed in after recording stops)
      outputFile,
    ];
  }

  /**
   * Screencast input: a constant-rate MJPEG stream on stdin, produced by FramePacer.
   *
   * `-framerate` on the INPUT is what makes video time equal wall time — ffmpeg
   * timestamps frame N at N/fps, and the pacer guarantees exactly fps frames per
   * elapsed second. Do not add an output -r or a vfr filter; either would reinterpret
   * that timeline.
   *
   * The fragmented-mp4 movflags are what let the byte stream be split and rejoined:
   * empty_moov puts the header up front and each fragment carries its own index, so
   * concatenation restores the file and any prefix plays on its own. (+faststart is
   * deliberately absent — it is incompatible with empty_moov, and playback is a local
   * file rather than a range-seeked HTTP resource.)
   */
  private buildScreencastArgs(): string[] {
    return [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', String(this.fps),
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '26',
      '-pix_fmt', 'yuv420p',
      '-g', String(this.fps * 2),
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-an',
      // Streaming mode needs an explicit muxer: with pipe:1 ffmpeg cannot infer one from a
      // filename extension. Without a chunk sink we keep writing a plain file, which is what
      // the guest/local path and the smoke test use.
      ...(this.onChunk ? ['-f', 'mp4', 'pipe:1'] : [this.filePath]),
    ];
  }
}
