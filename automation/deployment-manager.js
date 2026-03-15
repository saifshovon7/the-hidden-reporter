'use strict';
// WARNING: This file is NOT used. Deployment is handled by article-queue.js deployBatch().
// This file is kept for reference only. Do not import it.
/**
 * deployment-manager.js
 * Controls deployment frequency to prevent excessive Cloudflare Pages builds.
 * 
 * Features:
 * - Batch publishing: accumulate articles before deploying
 * - Deployment limiter: max X deployments per hour
 * - Smart scheduling: deploy at optimal times
 */

const { config } = require('./config');
const { pushFiles } = require('./github-pusher');

// Deployment limiter settings
const MAX_DEPLOYMENTS_PER_HOUR = config.publishing?.maxDeploymentsPerHour || 3;
const MIN_MINUTES_BETWEEN_DEPLOYMENTS = 60 / MAX_DEPLOYMENTS_PER_HOUR;

// State
let deploymentQueue = [];
let lastDeploymentTime = null;
let deploymentsThisHour = 0;
let deploymentHistory = []; // Track timestamps

// Initialize - reset hourly counter
function initDeploymentManager() {
    const now = Date.now();
    // Filter out deployments older than 1 hour
    deploymentHistory = deploymentHistory.filter(t => now - t < 3600000);
    deploymentsThisHour = deploymentHistory.length;
    
    console.log(`[DeployManager] Initialized. Deployments this hour: ${deploymentsThisHour}/${MAX_DEPLOYMENTS_PER_HOUR}`);
}

// Check if we can deploy now
function canDeployNow() {
    const now = Date.now();
    const minutesSinceLastDeploy = lastDeploymentTime ? (now - lastDeploymentTime) / 60000 : 999;
    
    // Check hourly limit
    if (deploymentsThisHour >= MAX_DEPLOYMENTS_PER_HOUR) {
        return { canDeploy: false, reason: 'hourly_limit', waitMinutes: 60 };
    }
    
    // Check minimum interval
    if (minutesSinceLastDeploy < MIN_MINUTES_BETWEEN_DEPLOYMENTS) {
        return { 
            canDeploy: false, 
            reason: 'min_interval', 
            waitMinutes: MIN_MINUTES_BETWEEN_DEPLOYMENTS - minutesSinceLastDeploy 
        };
    }
    
    return { canDeploy: true };
}

// Queue a deployment
function queueDeployment(files, commitMessage) {
    deploymentQueue.push({ files, commitMessage, queuedAt: Date.now() });
    console.log(`[DeployManager] Queued deployment. Queue size: ${deploymentQueue.length}`);
}

// Process deployment queue
async function processQueue() {
    // Check if we can deploy
    const { canDeploy, reason, waitMinutes } = canDeployNow();
    
    if (!canDeploy) {
        if (deploymentQueue.length > 0) {
            console.log(`[DeployManager] Cannot deploy yet: ${reason}. Waiting...`);
        }
        return false;
    }
    
    // Get next deployment from queue
    const deployment = deploymentQueue.shift();
    if (!deployment) {
        return false;
    }
    
    try {
        console.log(`[DeployManager] Deploying ${deployment.files.length} files...`);
        await pushFiles(deployment.files, deployment.commitMessage);
        
        // Record deployment
        lastDeploymentTime = Date.now();
        deploymentHistory.push(lastDeploymentTime);
        deploymentsThisHour++;
        
        console.log(`[DeployManager] Deployment complete. Today: ${deploymentsThisHour}/${MAX_DEPLOYMENTS_PER_HOUR}`);
        return true;
        
    } catch (err) {
        console.error(`[DeployManager] Deployment failed: ${err.message}`);
        // Re-queue for retry
        deploymentQueue.unshift(deployment);
        return false;
    }
}

// Get deployment status
function getStatus() {
    return {
        queued: deploymentQueue.length,
        deploymentsThisHour,
        maxPerHour: MAX_DEPLOYMENTS_PER_HOUR,
        lastDeployment: lastDeploymentTime ? new Date(lastDeploymentTime).toISOString() : null,
        canDeploy: canDeployNow().canDeploy
    };
}

// Schedule periodic queue processing
function startDeploymentScheduler(intervalMinutes = 5) {
    console.log(`[DeployManager] Starting scheduler (check every ${intervalMinutes} min)`);
    
    setInterval(async () => {
        if (deploymentQueue.length > 0) {
            await processQueue();
        }
    }, intervalMinutes * 60000);
}

module.exports = {
    initDeploymentManager,
    queueDeployment,
    processQueue,
    getStatus,
    canDeployNow,
    startDeploymentScheduler
};
