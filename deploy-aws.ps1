# ============================================================
# deploy-aws.ps1 — Build, Push to ECR, and Create ECS Cluster
#
# Prerequisites:
#   - AWS CLI v2 installed (winget install Amazon.AWSCLI)
#   - Docker Desktop running
#   - AWS credentials configured (aws configure)
#
# Usage:
#   cd C:\path\to\GOGOTRADE
#   .\deploy-aws.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# ---- Configuration ----
$AWS_REGION = "us-east-1"
$ECR_REPO_NAME = "gogotrade"
$ECS_CLUSTER_NAME = "TradingCluster"
$IMAGE_TAG = "latest"

# ---- Derive AWS Account ID ----
Write-Host "[1/5] Fetching AWS Account ID..." -ForegroundColor Cyan
$ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
if (-not $ACCOUNT_ID) {
    Write-Host "ERROR: Could not determine AWS Account ID. Run 'aws configure' first." -ForegroundColor Red
    exit 1
}
$ECR_URI = "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME"
Write-Host "       Account: $ACCOUNT_ID"
Write-Host "       ECR URI: $ECR_URI"

# ---- Step 2: Create ECR Repository (if it doesn't exist) ----
Write-Host "[2/5] Creating ECR repository '$ECR_REPO_NAME'..." -ForegroundColor Cyan
$repoExists = aws ecr describe-repositories --repository-names $ECR_REPO_NAME --region $AWS_REGION 2>$null
if (-not $repoExists) {
    aws ecr create-repository `
        --repository-name $ECR_REPO_NAME `
        --region $AWS_REGION `
        --image-scanning-configuration scanOnPush=true
}
Write-Host "       ECR repository ready."

# ---- Step 3: Authenticate Docker with ECR ----
Write-Host "[3/5] Authenticating Docker with ECR..." -ForegroundColor Cyan
$loginPassword = aws ecr get-login-password --region $AWS_REGION
$loginPassword | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# ---- Step 4: Build Docker Image ----
Write-Host "[4/5] Building Docker image..." -ForegroundColor Cyan
docker build -t "${ECR_REPO_NAME}:${IMAGE_TAG}" .
docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"

# ---- Step 5: Push to ECR ----
Write-Host "[5/5] Pushing image to ECR..." -ForegroundColor Cyan
docker push "${ECR_URI}:${IMAGE_TAG}"

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  Docker image pushed successfully!" -ForegroundColor Green
Write-Host "  ${ECR_URI}:${IMAGE_TAG}" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

# ---- Create ECS Cluster (skip if exists) ----
Write-Host ""
Write-Host "[ECS] Creating Fargate cluster '$ECS_CLUSTER_NAME'..." -ForegroundColor Cyan
$clusterExists = aws ecs describe-clusters --clusters $ECS_CLUSTER_NAME --region $AWS_REGION --query "clusters[?status=='ACTIVE'].clusterName" --output text 2>$null
if ($clusterExists -eq $ECS_CLUSTER_NAME) {
    Write-Host "       Cluster '$ECS_CLUSTER_NAME' already exists, skipping." -ForegroundColor Yellow
} else {
    aws ecs create-cluster `
        --cluster-name $ECS_CLUSTER_NAME `
        --region $AWS_REGION `
        --capacity-providers FARGATE `
        --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1
}

# ---- Register Task Definition ----
Write-Host "[ECS] Registering task definition..." -ForegroundColor Cyan

# Auto-replace ACCOUNT_ID placeholder in task definition
$taskDefContent = Get-Content -Path "gogotrade-task.json" -Raw
$taskDefContent = $taskDefContent -replace "ACCOUNT_ID", $ACCOUNT_ID
$tempTaskDef = "gogotrade-task-resolved.json"
[System.IO.File]::WriteAllText($tempTaskDef, $taskDefContent, (New-Object System.Text.UTF8Encoding $false))

aws ecs register-task-definition `
    --cli-input-json "file://$tempTaskDef" `
    --region $AWS_REGION

Remove-Item $tempTaskDef -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  AWS Deployment Complete!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next step - create the ECS Service (replace SUBNET and SG IDs):" -ForegroundColor Yellow
Write-Host ""
$serviceCmd = @"
aws ecs create-service ``
    --cluster $ECS_CLUSTER_NAME ``
    --service-name gogotrade-service ``
    --task-definition gogotrade ``
    --desired-count 1 ``
    --launch-type FARGATE ``
    --network-configuration "awsvpcConfiguration={subnets=[subnet-XXXX],securityGroups=[sg-XXXX],assignPublicIp=ENABLED}" ``
    --region $AWS_REGION
"@
Write-Host $serviceCmd -ForegroundColor White
