# Base Python image
FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Install shared library first
COPY ./libs/shared-models /app/libs/shared-models
RUN pip install --no-cache-dir /app/libs/shared-models

# Copy application code and requirements
COPY ./services/api-gateway/requirements.txt /app/
COPY ./services/api-gateway/main.py /app/
COPY ./services/api-gateway/dna_direct_import.py /app/

# Copy DNA submodule for direct imports
COPY ./services/dna /app/dna

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Expose port (e.g., 8000 for the gateway)
EXPOSE 8000

# Command to run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"] 