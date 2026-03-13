#!/usr/bin/env bash
# ============================================================
# deploy-aws.sh — Build, Push to ECR, and Create ECS Cluster
#
# Prerequisites:
#   - AWS CLI v2 installed and configured (aws configure)
#   - Docker running locally
#   - Correct AWS credentials with ECR + ECS permissions
#
# Usage:
#   chmod +x deploy-aws.sh
#   ./deploy-aws.sh
# ============================================================

set -euo pipefail

# ---- Configuration ----
AWS_REGION="us-east-1"
ECR_REPO_NAME="gogotrade"
ECS_CLUSTER_NAME="TradingCluster"
IMAGE_TAG="latest"

# ---- Derive AWS Account ID ----
echo "[1/5] Fetching AWS Account ID..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$ACCOUNT_ID" ]; then
  echo "ERROR: Could not determine AWS Account ID. Run 'aws configure' first."
  exit 1
fi
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"
echo "       Account: ${ACCOUNT_ID}"
echo "       ECR URI: ${ECR_URI}"

# ---- Step 1: Create ECR Repository (if it doesn't exist) ----
echo "[2/5] Creating ECR repository '${ECR_REPO_NAME}'..."
aws ecr describe-repositories \
  --repository-names "${ECR_REPO_NAME}" \
  --region "${AWS_REGION}" > /dev/null 2>&1 \
|| aws ecr create-repository \
  --repository-name "${ECR_REPO_NAME}" \
  --region "${AWS_REGION}" \
  --image-scanning-configuration scanOnPush=true \
  --query 'repository.repositoryUri' \
  --output text
echo "       ECR repository ready."

# ---- Step 2: Authenticate Docker with ECR ----
echo "[3/5] Authenticating Docker with ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# ---- Step 3: Build Docker Image ----
echo "[4/5] Building Docker image..."
docker build -t "${ECR_REPO_NAME}:${IMAGE_TAG}" .

# Tag for ECR
docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"

# ---- Step 4: Push to ECR ----
echo "[5/5] Pushing image to ECR..."
docker push "${ECR_URI}:${IMAGE_TAG}"

echo ""
echo "========================================="
echo "  Docker image pushed successfully!"
echo "  ${ECR_URI}:${IMAGE_TAG}"
echo "========================================="

# ---- Step 5: Create ECS Cluster ----
echo ""
echo "[ECS] Creating Fargate cluster '${ECS_CLUSTER_NAME}'..."
aws ecs create-cluster \
  --cluster-name "${ECS_CLUSTER_NAME}" \
  --region "${AWS_REGION}" \
  --capacity-providers FARGATE \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
  --query 'cluster.clusterArn' \
  --output text 2>/dev/null \
|| echo "       Cluster '${ECS_CLUSTER_NAME}' already exists."

echo ""
echo "========================================="
echo "  AWS Deployment Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Register the task definition:"
echo "     aws ecs register-task-definition --cli-input-json file://gogotrade-task.json --region ${AWS_REGION}"
echo ""
echo "  2. Create an ECS Service (replace SUBNET and SG IDs):"
echo "     aws ecs create-service \\"
echo "       --cluster ${ECS_CLUSTER_NAME} \\"
echo "       --service-name gogotrade-service \\"
echo "       --task-definition gogotrade \\"
echo "       --desired-count 1 \\"
echo "       --launch-type FARGATE \\"
echo "       --network-configuration 'awsvpcConfiguration={subnets=[subnet-XXXX],securityGroups=[sg-XXXX],assignPublicIp=ENABLED}' \\"
echo "       --region ${AWS_REGION}"
