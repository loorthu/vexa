#!/bin/bash
#
# docker_cleanup.sh
# Safely stop and remove all Docker containers, images, networks, and volumes (optional)
#

set -e  # Exit on error
set -o pipefail

echo "=== Docker Cleanup Script ==="

# Step 1: Stop all running containers
echo "Stopping all running containers..."
docker ps -q | xargs -r docker stop

# Step 2: Remove all containers
echo "Removing all containers..."
docker ps -aq | xargs -r docker rm -f

# Step 3: Remove all images
echo "Removing all images..."
docker images -q | xargs -r docker rmi -f


# Step 4: (Optional) Remove unused networks
echo "Pruning unused networks..."
docker network prune -f

# Step 5: (Optional) Remove unused volumes
echo "Remove vexa volumes..."
docker volume rm vexa_dev_postgres-data vexa_dev_redis-data
echo "Pruning unused volumes..."
docker volume prune -f

# Step 6: (Optional) Remove build cache and other system data
echo "Running full Docker system prune (safe cleanup of dangling data)..."
docker system prune -f

echo "=== Cleanup complete! ==="
docker images

