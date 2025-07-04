import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FacebookAdsApi, AdAccount, Campaign, Ad, AdSet } from 'facebook-nodejs-business-sdk';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// Load environment variables
dotenv.config();

// Initialize Facebook API
const accessToken = process.env.FB_ACCESS_TOKEN;
const accountId = process.env.FB_ACCOUNT_ID;
FacebookAdsApi.init(accessToken);

// Performance thresholds
const THRESHOLDS = {
    ctr: { good: 1.5, average: 0.8, critical: 0.5 },
    cpm: { good: 30, average: 50, critical: 75 },
    frequency: { optimal: 3, warning: 5, critical: 7 },
    spend: { minForAnalysis: 10, dailyLimit: 500 },
    roas: { good: 3, average: 2, poor: 1.5 }
};

// Notification priorities
const NOTIFICATION_PRIORITY = {
    CRITICAL: 'critical',     // Immediate action required
    URGENT: 'urgent',         // Needs attention within hours
    WARNING: 'warning',       // Should review soon
    INFO: 'info',            // Regular updates
    SUCCESS: 'success'       // Positive alerts
};

// State management
const stateFile = path.join(process.cwd(), 'campaign-state.json');
let campaignState = {};
let pendingApprovals = new Map();

// Load state on startup
async function loadState() {
    try {
        const data = await fs.readFile(stateFile, 'utf8');
        campaignState = JSON.parse(data);
    } catch (error) {
        campaignState = {};
    }
}

// Save state
async function saveState() {
    await fs.writeFile(stateFile, JSON.stringify(campaignState, null, 2));
}

// Track campaign changes
function detectSignificantChanges(campaignId, currentMetrics) {
    const previous = campaignState[campaignId];
    if (!previous) {
        campaignState[campaignId] = {
            ...currentMetrics,
            lastChecked: new Date().toISOString()
        };
        return null;
    }
    
    const changes = [];
    const ctrChange = ((currentMetrics.ctr - previous.ctr) / previous.ctr) * 100;
    const cpmChange = ((currentMetrics.cpm - previous.cpm) / previous.cpm) * 100;
    
    // Detect CTR crash
    if (ctrChange < -30 && currentMetrics.ctr < THRESHOLDS.ctr.average) {
        changes.push({
            type: 'CTR_CRASH',
            priority: NOTIFICATION_PRIORITY.CRITICAL,
            message: `🚨 CTR crashed ${Math.abs(ctrChange).toFixed(0)}% from ${previous.ctr}% to ${currentMetrics.ctr}%`,
            recommendation: 'Pause campaign and review creative immediately'
        });
    }
    
    // Detect CPM spike
    if (cpmChange > 50 && currentMetrics.cpm > THRESHOLDS.cpm.average) {
        changes.push({
            type: 'CPM_SPIKE',
            priority: NOTIFICATION_PRIORITY.URGENT,
            message: `⚠️ CPM increased ${cpmChange.toFixed(0)}% to $${currentMetrics.cpm}`,
            recommendation: 'Review audience targeting and competition'
        });
    }
    
    // Detect positive changes
    if (ctrChange > 50 && currentMetrics.ctr > THRESHOLDS.ctr.good) {
        changes.push({
            type: 'PERFORMANCE_BOOST',
            priority: NOTIFICATION_PRIORITY.SUCCESS,
            message: `🚀 CTR improved ${ctrChange.toFixed(0)}% to ${currentMetrics.ctr}%`,
            recommendation: 'Consider increasing budget to scale'
        });
    }
    
    // Update state
    campaignState[campaignId] = {
        ...currentMetrics,
        lastChecked: new Date().toISOString(),
        previousCtr: previous.ctr,
        previousCpm: previous.cpm
    };
    
    return changes.length > 0 ? changes : null;
}

// Helper: Analyze metrics with notification logic
function analyzeMetrics(metrics, context = {}) {
    const analysis = {
        issues: [],
        recommendations: [],
        notifications: [],
        score: 100,
        status: 'optimal'
    };
    
    // CTR Analysis
    const ctr = parseFloat(metrics.ctr || 0);
    if (ctr < THRESHOLDS.ctr.critical) {
        analysis.issues.push(`Critical CTR: ${ctr.toFixed(2)}%`);
        analysis.recommendations.push('🚨 Immediate action needed: Pause and revise creative');
        analysis.score -= 40;
        analysis.status = 'critical';
        
        if (parseFloat(metrics.spend || 0) > 50) {
            analysis.notifications.push({
                priority: NOTIFICATION_PRIORITY.CRITICAL,
                message: `Critical performance alert: CTR ${ctr.toFixed(2)}% with $${metrics.spend} spent`,
                requiresApproval: true,
                suggestedAction: 'PAUSE_CAMPAIGN'
            });
        }
    } else if (ctr < THRESHOLDS.ctr.average) {
        analysis.issues.push(`Low CTR: ${ctr.toFixed(2)}%`);
        analysis.recommendations.push('Test new ad creative with stronger hooks');
        analysis.score -= 25;
        analysis.status = 'needs_improvement';
    } else if (ctr > THRESHOLDS.ctr.good) {
        analysis.recommendations.push(`🎯 Excellent CTR (${ctr.toFixed(2)}%) - Scale this winner`);
        
        if (context.campaignBudget && parseFloat(context.campaignBudget) < 100) {
            analysis.notifications.push({
                priority: NOTIFICATION_PRIORITY.SUCCESS,
                message: `High performer alert: ${ctr.toFixed(2)}% CTR - Ready to scale`,
                suggestedAction: 'INCREASE_BUDGET',
                suggestedValue: Math.min(parseFloat(context.campaignBudget) * 2, 200)
            });
        }
    }
    
    // CPM Analysis (AUD specific)
    const cpm = parseFloat(metrics.cpm || 0);
    if (cpm > THRESHOLDS.cpm.critical) {
        analysis.issues.push(`Critical CPM: $${cpm.toFixed(2)} AUD`);
        analysis.recommendations.push('🚨 CPMs too high - Pause and revise targeting');
        analysis.score -= 30;
        analysis.notifications.push({
            priority: NOTIFICATION_PRIORITY.URGENT,
            message: `High CPM alert: $${cpm.toFixed(2)} AUD`,
            suggestedAction: 'REVIEW_TARGETING'
        });
    } else if (cpm > THRESHOLDS.cpm.average) {
        analysis.issues.push(`High CPM: $${cpm.toFixed(2)} AUD`);
        analysis.recommendations.push('Broaden targeting or test new audiences');
        analysis.score -= 20;
    }
    
    // Frequency Analysis
    const frequency = parseFloat(metrics.frequency || 0);
    if (frequency > THRESHOLDS.frequency.critical) {
        analysis.issues.push(`Critical frequency: ${frequency.toFixed(2)}`);
        analysis.recommendations.push('🚨 Severe ad fatigue - Refresh creative immediately');
        analysis.score -= 30;
        analysis.notifications.push({
            priority: NOTIFICATION_PRIORITY.URGENT,
            message: `Ad fatigue alert: Frequency ${frequency.toFixed(2)}`,
            requiresApproval: true,
            suggestedAction: 'REFRESH_CREATIVE'
        });
    } else if (frequency > THRESHOLDS.frequency.warning) {
        analysis.issues.push(`High frequency: ${frequency.toFixed(2)}`);
        analysis.recommendations.push('Audience fatigue emerging - Plan creative refresh');
        analysis.score -= 15;
    }
    
    // ROAS Analysis if available
    if (metrics.purchase_roas) {
        const roas = parseFloat(metrics.purchase_roas[0]?.value || 0);
        if (roas < THRESHOLDS.roas.poor) {
            analysis.issues.push(`Poor ROAS: ${roas.toFixed(2)}x`);
            analysis.recommendations.push('Review product-market fit and pricing');
            analysis.score -= 20;
        } else if (roas > THRESHOLDS.roas.good) {
            analysis.recommendations.push(`💰 Strong ROAS (${roas.toFixed(2)}x) - Increase investment`);
        }
    }
    
    // Set final status
    if (analysis.score < 40) analysis.status = 'critical';
    else if (analysis.score < 60) analysis.status = 'poor';
    else if (analysis.score < 80) analysis.status = 'needs_improvement';
    else if (analysis.score >= 95) analysis.status = 'excellent';
    
    return analysis;
}

// Format WhatsApp message
function formatWhatsAppMessage(data, type) {
    const emoji = {
        critical: '🚨',
        urgent: '⚠️',
        warning: '⚡',
        info: 'ℹ️',
        success: '🎉'
    };
    
    let message = `${emoji[data.priority] || '📊'} *Facebook Ads Alert*\n\n`;
    
    switch (type) {
        case 'performance_summary':
            message += `*Account Performance Summary*\n`;
            message += `Period: ${data.period}\n`;
            message += `Spend: ${data.spend}\n`;
            message += `Overall CTR: ${data.ctr}\n`;
            message += `Overall CPM: ${data.cpm}\n\n`;
            
            if (data.topIssues && data.topIssues.length > 0) {
                message += `*Issues Requiring Attention:*\n`;
                data.topIssues.forEach(issue => {
                    message += `• ${issue}\n`;
                });
            }
            
            if (data.recommendations && data.recommendations.length > 0) {
                message += `\n*Recommendations:*\n`;
                data.recommendations.forEach(rec => {
                    message += `• ${rec}\n`;
                });
            }
            break;
            
        case 'approval_request':
            message += `*Action Required*\n\n`;
            message += data.message + '\n\n';
            message += `*Approval ID:* ${data.approvalId}\n`;
            message += `*Expires:* ${data.expiresAt}\n\n`;
            message += `Reply with:\n`;
            message += `• APPROVE ${data.approvalId} - Execute action\n`;
            message += `• REJECT ${data.approvalId} - Cancel action\n`;
            message += `• INFO ${data.approvalId} - Get more details`;
            break;
            
        case 'campaign_alert':
            message += `*Campaign Alert*\n`;
            message += `Campaign: ${data.campaignName}\n`;
            message += `Issue: ${data.issue}\n`;
            message += `Current Performance:\n`;
            message += `• CTR: ${data.metrics.ctr}\n`;
            message += `• CPM: ${data.metrics.cpm}\n`;
            message += `• Spend: ${data.metrics.spend}\n\n`;
            message += `Recommendation: ${data.recommendation}`;
            break;
    }
    
    return message;
}

// Create approval request
function createApprovalRequest(action, data) {
    const approvalId = `APR${Date.now()}`;
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
    
    pendingApprovals.set(approvalId, {
        action,
        data,
        createdAt: new Date(),
        expiresAt,
        status: 'pending'
    });
    
    return {
        approvalId,
        expiresAt: expiresAt.toISOString(),
        action,
        summary: data
    };
}

// Create MCP server using McpServer
const server = new McpServer({
    name: 'facebook-ads-mcp',
    version: '1.0.0',
    description: 'Facebook Ads Media Buying Agent with WhatsApp Integration'
});

// --- capture every tool we register so Express can execute them easily ----
const customToolRegistry = new Map();
const _originalRegisterTool = server.registerTool.bind(server);

server.registerTool = (name, schema, fn) => {
  // store a lightweight wrapper that exposes an execute() method
  customToolRegistry.set(name, { execute: fn });
  return _originalRegisterTool(name, schema, fn);
};

// Register tools using registerTool and zod schemas
server.registerTool(
    'get_account_overview',
    {
        title: 'Get Account Overview',
        description: 'Get account performance overview with WhatsApp notification formatting',
        inputSchema: z.object({
            dateRange: z.string().default('last_7d'),
            sendNotification: z.boolean().default(false)
        })
    },
    async ({ dateRange, sendNotification }) => {
        await loadState();
        try {
            const account = new AdAccount(accountId);
            // Get account info
            const accountInfo = await account.read(['name', 'account_status', 'currency', 'balance']);
            // Get account insights
            const insights = await account.getInsights(
                ['spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpp', 'purchase_roas'],
                { 
                    date_preset: dateRange || 'last_7d',
                    level: 'account'
                }
            );
            // Get active campaigns
            const campaigns = await account.getCampaigns(
                ['name', 'status', 'daily_budget', 'lifetime_budget', 'objective'],
                { 
                    filtering: [
                      { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
                    ],
                    limit: 50
                }
            );
            // Get campaigns with issues
            const campaignsWithIssues = [];
            for (const campaign of campaigns.slice(0, 10)) {
                const campaignInsights = await campaign.getInsights(
                    ['ctr', 'cpm', 'spend'],
                    { date_preset: 'last_3d' }
                );
                if (campaignInsights[0]) {
                    const metrics = campaignInsights[0];
                    const analysis = analyzeMetrics(metrics);
                    if (analysis.status === 'critical' || analysis.status === 'poor') {
                        campaignsWithIssues.push({
                            name: campaign.name,
                            status: analysis.status,
                            issues: analysis.issues
                        });
                    }
                }
            }
            // Analyze overall performance
            const performance = insights[0] || {};
            const analysis = analyzeMetrics(performance);
            // Prepare response
            const response = {
                account: {
                    name: accountInfo.name,
                    status: accountInfo.account_status === 1 ? 'Active' : 'Inactive',
                    currency: accountInfo.currency,
                    balance: accountInfo.balance
                },
                period: dateRange || 'last_7d',
                performance: {
                    spend: `$${performance.spend} ${accountInfo.currency}`,
                    impressions: performance.impressions,
                    clicks: performance.clicks,
                    ctr: `${performance.ctr}%`,
                    cpm: `$${performance.cpm} ${accountInfo.currency}`,
                    roas: performance.purchase_roas ? `${performance.purchase_roas[0]?.value}x` : 'N/A'
                },
                analysis: analysis,
                activeCampaigns: {
                    count: campaigns.length,
                    withIssues: campaignsWithIssues.length,
                    campaigns: campaigns.slice(0, 10).map(c => ({
                        name: c.name,
                        objective: c.objective,
                        dailyBudget: c.daily_budget ? `$${c.daily_budget}` : 'N/A'
                    }))
                },
                campaignsWithIssues: campaignsWithIssues
            };
            // Add WhatsApp notification if needed
            if (sendNotification || campaignsWithIssues.length > 0) {
                const priority = campaignsWithIssues.length > 3 ? NOTIFICATION_PRIORITY.URGENT : NOTIFICATION_PRIORITY.INFO;
                response.whatsappNotification = {
                    type: 'performance_summary',
                    priority: priority,
                    message: formatWhatsAppMessage({
                        priority: priority,
                        period: dateRange || 'last_7d',
                        spend: response.performance.spend,
                        ctr: response.performance.ctr,
                        cpm: response.performance.cpm,
                        topIssues: campaignsWithIssues.slice(0, 3).map(c => `${c.name}: ${c.issues.join(', ')}`),
                        recommendations: analysis.recommendations.slice(0, 3)
                    }, 'performance_summary')
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'get_account_overview',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

server.registerTool(
    'analyze_campaign',
    {
        title: 'Analyze Campaign',
        description: 'Deep analysis of campaign with change detection',
        inputSchema: z.object({
            campaignId: z.string()
        })
    },
    async ({ campaignId }) => {
        await loadState();
        try {
            if (!campaignId) {
                throw new Error('Campaign ID is required');
            }
            const campaign = new Campaign(campaignId);
            // Get campaign details
            const campaignData = await campaign.read(['name', 'status', 'objective', 'daily_budget']);
            // Get insights
            const insights = await campaign.getInsights(
                ['impressions', 'clicks', 'spend', 'ctr', 'cpm', 'frequency', 'reach', 'purchase_roas'],
                { date_preset: 'last_7d' }
            );
            // Get ad sets for more detailed analysis
            const adSets = await campaign.getAdSets(
                ['name', 'status', 'daily_budget', 'targeting'],
                { limit: 50 }
            );
            const metrics = insights[0] || {};
            // Detect changes from previous check
            const changes = detectSignificantChanges(campaignId, {
                ctr: parseFloat(metrics.ctr || 0),
                cpm: parseFloat(metrics.cpm || 0),
                spend: parseFloat(metrics.spend || 0),
                frequency: parseFloat(metrics.frequency || 0)
            });
            // Analyze with campaign context
            const analysis = analyzeMetrics(metrics, {
                campaignBudget: campaignData.daily_budget,
                campaignName: campaignData.name
            });
            // Campaign-specific recommendations
            if (campaignData.status === 'ACTIVE' && analysis.score < 60) {
                analysis.recommendations.unshift('⚠️ Consider pausing for immediate optimization');
            }
            const response = {
                campaign: {
                    id: campaignId,
                    name: campaignData.name,
                    status: campaignData.status,
                    objective: campaignData.objective,
                    dailyBudget: campaignData.daily_budget ? `$${campaignData.daily_budget}` : 'N/A'
                },
                metrics: {
                    spend: `$${metrics.spend}`,
                    impressions: metrics.impressions,
                    clicks: metrics.clicks,
                    ctr: `${metrics.ctr}%`,
                    cpm: `$${metrics.cpm}`,
                    frequency: metrics.frequency,
                    reach: metrics.reach,
                    roas: metrics.purchase_roas ? `${metrics.purchase_roas[0]?.value}x` : 'N/A'
                },
                analysis: analysis,
                changes: changes,
                adSets: {
                    count: adSets.length,
                    active: adSets.filter(as => as.status === 'ACTIVE').length
                }
            };
            // Add notifications for significant changes or issues
            if (changes && changes.length > 0) {
                const mostUrgentChange = changes.reduce((prev, current) => 
                    prev.priority === NOTIFICATION_PRIORITY.CRITICAL ? prev : current
                );
                response.whatsappNotification = {
                    type: 'campaign_alert',
                    priority: mostUrgentChange.priority,
                    message: formatWhatsAppMessage({
                        priority: mostUrgentChange.priority,
                        campaignName: campaignData.name,
                        issue: mostUrgentChange.message,
                        metrics: {
                            ctr: metrics.ctr,
                            cpm: `$${metrics.cpm}`,
                            spend: `$${metrics.spend}`
                        },
                        recommendation: mostUrgentChange.recommendation
                    }, 'campaign_alert')
                };
            }
            await saveState();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'analyze_campaign',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

server.registerTool(
    'get_winning_ads',
    {
        title: 'Get Winning Ads',
        description: 'Find top performing ads with scaling recommendations',
        inputSchema: z.object({
            limit: z.number().default(5)
        })
    },
    async ({ limit }) => {
        await loadState();
        try {
            const account = new AdAccount(accountId);
            // Get all active ads
            const ads = await account.getAds(
                ['name', 'status', 'campaign_id', 'adset_id', 'creative'],
                { 
                    filtering: [{ field: 'status', operator: 'IN', value: ['ACTIVE'] }],
                    limit: 500
                }
            );
            // Get insights for each ad with campaign context
            const adsWithInsights = await Promise.all(
                ads.map(async (ad) => {
                    try {
                        const insights = await ad.getInsights(
                            ['impressions', 'clicks', 'spend', 'ctr', 'cpm', 'frequency', 'purchase_roas'],
                            { date_preset: 'last_7d' }
                        );
                        // Get campaign info for context
                        const campaign = new Campaign(ad.campaign_id);
                        const campaignData = await campaign.read(['name', 'daily_budget']);
                        const metrics = insights[0] || {};
                        return {
                            id: ad.id,
                            name: ad.name,
                            campaignName: campaignData.name,
                            campaignBudget: campaignData.daily_budget,
                            impressions: parseInt(metrics.impressions || 0),
                            clicks: parseInt(metrics.clicks || 0),
                            spend: parseFloat(metrics.spend || 0),
                            ctr: parseFloat(metrics.ctr || 0),
                            cpm: parseFloat(metrics.cpm || 0),
                            frequency: parseFloat(metrics.frequency || 0),
                            roas: metrics.purchase_roas ? parseFloat(metrics.purchase_roas[0]?.value || 0) : 0
                        };
                    } catch (error) {
                        return null;
                    }
                })
            );
            // Filter valid ads with enough data
            const validAds = adsWithInsights
                .filter(ad => ad && ad.impressions > 1000 && ad.spend > THRESHOLDS.spend.minForAnalysis)
                .sort((a, b) => b.ctr - a.ctr);
            const winners = validAds.slice(0, limit);
            const losers = validAds.slice(-limit).reverse();
            // Identify scaling opportunities
            const scalingOpportunities = winners.filter(ad => 
                ad.ctr > THRESHOLDS.ctr.good && 
                ad.cpm < THRESHOLDS.cpm.average &&
                ad.campaignBudget < 100
            ).map(ad => ({
                adId: ad.id,
                adName: ad.name,
                campaignName: ad.campaignName,
                currentBudget: ad.campaignBudget,
                suggestedBudget: Math.min(ad.campaignBudget * 2, 200),
                rationale: `CTR ${ad.ctr.toFixed(2)}% with CPM $${ad.cpm.toFixed(2)}`
            }));
            const response = {
                topPerformers: winners.map(ad => ({
                    ...ad,
                    spend: `$${ad.spend.toFixed(2)}`,
                    ctr: `${ad.ctr.toFixed(2)}%`,
                    cpm: `$${ad.cpm.toFixed(2)}`,
                    roas: ad.roas ? `${ad.roas.toFixed(2)}x` : 'N/A',
                    analysis: analyzeMetrics(ad)
                })),
                bottomPerformers: losers.map(ad => ({
                    ...ad,
                    spend: `$${ad.spend.toFixed(2)}`,
                    ctr: `${ad.ctr.toFixed(2)}%`,
                    cpm: `$${ad.cpm.toFixed(2)}`,
                    roas: ad.roas ? `${ad.roas.toFixed(2)}x` : 'N/A',
                    analysis: analyzeMetrics(ad)
                })),
                insights: {
                    avgWinnerCtr: `${(winners.reduce((sum, ad) => sum + ad.ctr, 0) / winners.length).toFixed(2)}%`,
                    avgLoserCtr: `${(losers.reduce((sum, ad) => sum + ad.ctr, 0) / losers.length).toFixed(2)}%`,
                    potentialSavings: `$${losers.reduce((sum, ad) => sum + ad.spend, 0).toFixed(2)}`,
                    scalingOpportunities: scalingOpportunities.length
                },
                scalingOpportunities: scalingOpportunities
            };
            // Create notification for scaling opportunities
            if (scalingOpportunities.length > 0) {
                response.whatsappNotification = {
                    type: 'scaling_opportunity',
                    priority: NOTIFICATION_PRIORITY.SUCCESS,
                    message: `🚀 *Scaling Opportunities Found*\n\n` +
                            `Found ${scalingOpportunities.length} high-performing ads ready to scale:\n\n` +
                            scalingOpportunities.slice(0, 3).map(opp => 
                                `• ${opp.adName}\n  Campaign: ${opp.campaignName}\n  ${opp.rationale}\n  Budget: $${opp.currentBudget} → $${opp.suggestedBudget}`
                            ).join('\n\n') +
                            `\n\nReply SCALE to review all opportunities.`
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'get_winning_ads',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

server.registerTool(
    'pause_poor_performers',
    {
        title: 'Pause Poor Performers',
        description: 'Identify and request approval to pause underperforming campaigns',
        inputSchema: z.object({
            ctrThreshold: z.number().default(0.5),
            minSpend: z.number().default(10),
            autoApprove: z.boolean().default(false)
        })
    },
    async ({ ctrThreshold, minSpend, autoApprove }) => {
        await loadState();
        try {
            const account = new AdAccount(accountId);
            // Get active campaigns
            const campaigns = await account.getCampaigns(
                ['name', 'status', 'daily_budget'],
                {
                  filtering: [
                    { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
                  ]
                }
            );
            const candidatesForPause = [];
            let totalDailySavings = 0;
            for (const campaign of campaigns) {
                const insights = await campaign.getInsights(
                    ['spend', 'ctr', 'impressions', 'clicks', 'cpm'],
                    { date_preset: 'last_3d' }
                );
                const metrics = insights[0] || {};
                const spend = parseFloat(metrics.spend || 0);
                const ctr = parseFloat(metrics.ctr || 0);
                const dailyBudget = parseFloat(campaign.daily_budget || 0);
                if (spend > minSpend && ctr < ctrThreshold) {
                    candidatesForPause.push({
                        id: campaign.id,
                        name: campaign.name,
                        ctr: ctr,
                        ctrFormatted: `${ctr.toFixed(2)}%`,
                        spend: spend,
                        spendFormatted: `${spend.toFixed(2)}`,
                        dailyBudget: dailyBudget,
                        impressions: metrics.impressions,
                        clicks: metrics.clicks,
                        cpm: `${parseFloat(metrics.cpm || 0).toFixed(2)}`,
                        reason: `CTR ${ctr.toFixed(2)}% is below threshold of ${ctrThreshold}%`,
                        estimatedDailySavings: dailyBudget
                    });
                    totalDailySavings += dailyBudget;
                }
            }
            const response = {
                mode: autoApprove ? 'AUTO' : 'APPROVAL_REQUIRED',
                campaignsAnalyzed: campaigns.length,
                candidatesForPause: candidatesForPause.length,
                candidates: candidatesForPause,
                criteria: {
                    ctrThreshold: `${ctrThreshold}%`,
                    minSpend: `${minSpend}`,
                    period: 'last_3d'
                },
                potentialDailySavings: `${totalDailySavings.toFixed(2)}`,
                potentialWeeklySavings: `${(totalDailySavings * 7).toFixed(2)}`
            };
            // If candidates found and not auto-approve, create approval request
            if (candidatesForPause.length > 0 && !autoApprove) {
                const approval = createApprovalRequest('PAUSE_CAMPAIGNS', {
                    campaigns: candidatesForPause.map(c => ({
                        id: c.id,
                        name: c.name,
                        ctr: c.ctrFormatted,
                        spend: c.spendFormatted
                    })),
                    totalCampaigns: candidatesForPause.length,
                    estimatedSavings: response.potentialDailySavings
                });
                response.approvalRequest = approval;
                response.whatsappNotification = {
                    type: 'approval_request',
                    priority: NOTIFICATION_PRIORITY.URGENT,
                    message: formatWhatsAppMessage({
                        priority: NOTIFICATION_PRIORITY.URGENT,
                        message: `Found ${candidatesForPause.length} underperforming campaigns:\n\n` +
                                candidatesForPause.slice(0, 5).map(c => 
                                    `• ${c.name}\n  CTR: ${c.ctrFormatted} | Spent: ${c.spendFormatted}`
                                ).join('\n') +
                                `\n\nPotential savings: ${response.potentialDailySavings}/day`,
                        approvalId: approval.approvalId,
                        expiresAt: approval.expiresAt
                    }, 'approval_request')
                };
            } else if (candidatesForPause.length > 0 && autoApprove) {
                // Auto-pause campaigns
                const pausedCampaigns = [];
                for (const candidate of candidatesForPause) {
                    try {
                        const campaign = new Campaign(candidate.id);
                        await campaign.update({ status: 'PAUSED' });
                        pausedCampaigns.push({
                            ...candidate,
                            action: 'PAUSED',
                            pausedAt: new Date().toISOString()
                        });
                    } catch (error) {
                        pausedCampaigns.push({
                            ...candidate,
                            action: 'FAILED',
                            error: error.message
                        });
                    }
                }
                response.executedActions = pausedCampaigns;
                response.whatsappNotification = {
                    type: 'action_completed',
                    priority: NOTIFICATION_PRIORITY.WARNING,
                    message: `⚠️ *Auto-Pause Executed*\n\n` +
                            `Paused ${pausedCampaigns.filter(c => c.action === 'PAUSED').length} campaigns:\n\n` +
                            pausedCampaigns.filter(c => c.action === 'PAUSED').slice(0, 5).map(c => 
                                `• ${c.name} (CTR: ${c.ctrFormatted})`
                            ).join('\n') +
                            `\n\nSavings: ${response.potentialDailySavings}/day`
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'pause_poor_performers',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

server.registerTool(
    'monitor_budget_pace',
    {
        title: 'Monitor Budget Pace',
        description: 'Check if campaigns are pacing correctly with spend alerts',
        inputSchema: z.object({
            alertThreshold: z.number().default(20)
        })
    },
    async ({ alertThreshold }) => {
        await loadState();
        try {
            const account = new AdAccount(accountId);
            // Get account spending limit
            const accountInfo = await account.read(['spend_cap', 'amount_spent']);
            // Get active campaigns with budgets
            const campaigns = await account.getCampaigns(
                ['name', 'status', 'daily_budget', 'lifetime_budget', 'created_time'],
                {
                  filtering: [
                    { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
                  ],
                  limit: 100
                }
            );
            const budgetAlerts = [];
            const now = new Date();
            const todayStart = new Date(now.setHours(0, 0, 0, 0));
            for (const campaign of campaigns) {
                if (!campaign.daily_budget) continue;
                // Get today's spend
                const insights = await campaign.getInsights(
                    ['spend'],
                    { 
                        time_range: {
                            since: todayStart.toISOString().split('T')[0],
                            until: now.toISOString().split('T')[0]
                        }
                    }
                );
                const todaySpend = parseFloat(insights[0]?.spend || 0);
                const dailyBudget = parseFloat(campaign.daily_budget);
                const hoursElapsed = now.getHours() + (now.getMinutes() / 60);
                const dayProgress = hoursElapsed / 24;
                const expectedSpend = dailyBudget * dayProgress;
                const pacePercentage = ((todaySpend / expectedSpend) - 1) * 100;
                // Check if significantly over or under pace
                if (Math.abs(pacePercentage) > alertThreshold) {
                    const status = pacePercentage > 0 ? 'OVERSPENDING' : 'UNDERSPENDING';
                    budgetAlerts.push({
                        campaignName: campaign.name,
                        campaignId: campaign.id,
                        status: status,
                        dailyBudget: `${dailyBudget.toFixed(2)}`,
                        todaySpend: `${todaySpend.toFixed(2)}`,
                        expectedSpend: `${expectedSpend.toFixed(2)}`,
                        pacePercentage: `${pacePercentage > 0 ? '+' : ''}${pacePercentage.toFixed(1)}%`,
                        recommendation: status === 'OVERSPENDING' 
                            ? 'Review targeting and competition. Consider reducing bids.'
                            : 'Check ad delivery. Consider increasing bids or broadening audience.'
                    });
                }
            }
            // Calculate total daily budget vs spend
            const totalDailyBudget = campaigns.reduce((sum, c) => sum + parseFloat(c.daily_budget || 0), 0);
            const totalTodaySpend = await account.getInsights(
                ['spend'],
                { 
                    time_range: {
                        since: todayStart.toISOString().split('T')[0],
                        until: now.toISOString().split('T')[0]
                    }
                }
            );
            const accountTodaySpend = parseFloat(totalTodaySpend[0]?.spend || 0);
            const accountExpectedSpend = totalDailyBudget * (now.getHours() / 24);
            const accountPace = ((accountTodaySpend / accountExpectedSpend) - 1) * 100;
            const response = {
                account: {
                    totalDailyBudget: `${totalDailyBudget.toFixed(2)}`,
                    todaySpendSoFar: `${accountTodaySpend.toFixed(2)}`,
                    expectedSpendByNow: `${accountExpectedSpend.toFixed(2)}`,
                    pacing: `${accountPace > 0 ? '+' : ''}${accountPace.toFixed(1)}%`,
                    projectedDayEndSpend: `${(accountTodaySpend / (now.getHours() / 24)).toFixed(2)}`
                },
                campaignsAnalyzed: campaigns.length,
                alertsFound: budgetAlerts.length,
                alerts: budgetAlerts,
                summary: {
                    overspending: budgetAlerts.filter(a => a.status === 'OVERSPENDING').length,
                    underspending: budgetAlerts.filter(a => a.status === 'UNDERSPENDING').length
                }
            };
            // Create notification if alerts found
            if (budgetAlerts.length > 0) {
                const priority = budgetAlerts.some(a => a.status === 'OVERSPENDING' && parseFloat(a.pacePercentage) > 50)
                    ? NOTIFICATION_PRIORITY.URGENT
                    : NOTIFICATION_PRIORITY.WARNING;
                response.whatsappNotification = {
                    type: 'budget_alert',
                    priority: priority,
                    message: `💰 *Budget Pacing Alert*\n\n` +
                            `Account pacing: ${response.account.pacing}\n` +
                            `Projected day-end: ${response.account.projectedDayEndSpend}\n\n` +
                            `*Campaigns needing attention:*\n` +
                            budgetAlerts.slice(0, 5).map(a => 
                                `• ${a.campaignName}\n  ${a.status} by ${a.pacePercentage}\n  Budget: ${a.dailyBudget} | Spent: ${a.todaySpend}`
                            ).join('\n\n') +
                            (budgetAlerts.length > 5 ? `\n\n...and ${budgetAlerts.length - 5} more` : '')
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'monitor_budget_pace',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

server.registerTool(
    'process_approval',
    {
        title: 'Process Approval',
        description: 'Process approval response from WhatsApp',
        inputSchema: z.object({
            approvalId: z.string(),
            action: z.string()
        })
    },
    async ({ approvalId, action }) => {
        await loadState();
        try {
            const act = action?.toUpperCase();
            if (!approvalId || !act) {
                throw new Error('Approval ID and action are required');
            }
            const approval = pendingApprovals.get(approvalId);
            if (!approval) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            error: 'Approval not found or expired',
                            approvalId: approvalId
                        }, null, 2)
                    }]
                };
            }
            if (approval.status !== 'pending') {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            error: 'Approval already processed',
                            approvalId: approvalId,
                            status: approval.status
                        }, null, 2)
                    }]
                };
            }
            if (new Date() > approval.expiresAt) {
                approval.status = 'expired';
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            error: 'Approval expired',
                            approvalId: approvalId,
                            expiredAt: approval.expiresAt
                        }, null, 2)
                    }]
                };
            }
            const response = {
                approvalId: approvalId,
                action: act,
                processedAt: new Date().toISOString(),
                results: []
            };
            if (act === 'APPROVE') {
                switch (approval.action) {
                    case 'PAUSE_CAMPAIGNS':
                        for (const campaign of approval.data.campaigns) {
                            try {
                                const fbCampaign = new Campaign(campaign.id);
                                await fbCampaign.update({ status: 'PAUSED' });
                                response.results.push({
                                    campaignId: campaign.id,
                                    campaignName: campaign.name,
                                    status: 'PAUSED',
                                    success: true
                                });
                            } catch (error) {
                                response.results.push({
                                    campaignId: campaign.id,
                                    campaignName: campaign.name,
                                    status: 'FAILED',
                                    success: false,
                                    error: error.message
                                });
                            }
                        }
                        response.summary = {
                            totalRequested: approval.data.campaigns.length,
                            successfullyPaused: response.results.filter(r => r.success).length,
                            failed: response.results.filter(r => !r.success).length,
                            estimatedSavings: approval.data.estimatedSavings
                        };
                        response.whatsappNotification = {
                            type: 'action_completed',
                            priority: NOTIFICATION_PRIORITY.INFO,
                            message: `✅ *Campaigns Paused*\n\n` +
                                    `Successfully paused ${response.summary.successfullyPaused} of ${response.summary.totalRequested} campaigns.\n\n` +
                                    `Estimated savings: ${response.summary.estimatedSavings}/day`
                        };
                        break;
                }
                approval.status = 'approved';
                approval.processedAt = new Date();
            } else if (act === 'REJECT') {
                approval.status = 'rejected';
                approval.processedAt = new Date();
                response.whatsappNotification = {
                    type: 'action_cancelled',
                    priority: NOTIFICATION_PRIORITY.INFO,
                    message: `❌ *Action Cancelled*\n\nApproval ${approvalId} has been rejected. No changes were made.`
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'process_approval',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

server.registerTool(
    'analyze_creative_performance',
    {
        title: 'Analyze Creative Performance',
        description: 'Deep analysis of creative elements and their performance correlation',
        inputSchema: z.object({
            lookbackDays: z.number().default(7),
            minImpressions: z.number().default(1000)
        })
    },
    async ({ lookbackDays, minImpressions }) => {
        await loadState();
        try {
            const account = new AdAccount(accountId);
            
            // Get all ads with creative info
            const ads = await account.getAds(
                ['name', 'creative', 'adset_id'],
                { 
                    filtering: [{ field: 'status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }],
                    limit: 500
                }
            );
            
            const creativeAnalysis = [];
            
            for (const ad of ads) {
                try {
                    // Get ad insights
                    const insights = await ad.getInsights(
                        ['impressions', 'clicks', 'spend', 'ctr', 'cpm', 'video_avg_time_watched_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'purchase_roas'],
                        { date_preset: `last_${lookbackDays}_d` }
                    );
                    
                    const metrics = insights[0] || {};
                    if (parseInt(metrics.impressions || 0) < minImpressions) continue;
                    
                    // Get creative details
                    const creative = await ad.getCreative(['title', 'body', 'image_url', 'video_id', 'thumbnail_url']);
                    
                    // Extract hook (first 3 seconds/first line of text)
                    const hook = creative.body ? creative.body.split('\n')[0].substring(0, 100) : 'No text';
                    
                    // Calculate video retention if available
                    const videoMetrics = {};
                    if (metrics.video_p25_watched_actions) {
                        const p25 = parseInt(metrics.video_p25_watched_actions[0]?.value || 0);
                        const p50 = parseInt(metrics.video_p50_watched_actions[0]?.value || 0);
                        const p75 = parseInt(metrics.video_p75_watched_actions[0]?.value || 0);
                        const p100 = parseInt(metrics.video_p100_watched_actions[0]?.value || 0);
                        
                        videoMetrics.retention = {
                            p25: p25,
                            p50: p50,
                            p75: p75,
                            p100: p100,
                            dropoffRate: p25 > 0 ? ((p25 - p100) / p25 * 100).toFixed(1) + '%' : 'N/A'
                        };
                    }
                    
                    creativeAnalysis.push({
                        adId: ad.id,
                        adName: ad.name,
                        creative: {
                            id: creative.id,
                            type: creative.video_id ? 'VIDEO' : 'IMAGE',
                            headline: creative.title || 'N/A',
                            hook: hook,
                            hasVideo: !!creative.video_id
                        },
                        performance: {
                            impressions: metrics.impressions,
                            ctr: parseFloat(metrics.ctr || 0),
                            cpm: parseFloat(metrics.cpm || 0),
                            spend: parseFloat(metrics.spend || 0),
                            roas: metrics.purchase_roas ? parseFloat(metrics.purchase_roas[0]?.value || 0) : null
                        },
                        videoMetrics: videoMetrics
                    });
                    
                } catch (error) {
                    console.error(`Error analyzing ad ${ad.id}:`, error);
                }
            }
            
            // Sort by CTR to find patterns
            creativeAnalysis.sort((a, b) => b.performance.ctr - a.performance.ctr);
            
            // Analyze patterns
            const topPerformers = creativeAnalysis.slice(0, 10);
            const bottomPerformers = creativeAnalysis.slice(-10);
            
            // Extract common elements in top performers
            const patterns = {
                hooks: {},
                types: { VIDEO: 0, IMAGE: 0 },
                avgRetentionTop: { p25: 0, p50: 0, p75: 0, p100: 0 },
                avgRetentionBottom: { p25: 0, p50: 0, p75: 0, p100: 0 }
            };
            
            // Analyze top performers
            topPerformers.forEach(ad => {
                patterns.types[ad.creative.type]++;
                
                // Extract hook patterns (first few words)
                const hookWords = ad.creative.hook.split(' ').slice(0, 3).join(' ').toLowerCase();
                patterns.hooks[hookWords] = (patterns.hooks[hookWords] || 0) + 1;
                
                // Video retention
                if (ad.videoMetrics.retention) {
                    patterns.avgRetentionTop.p25 += ad.videoMetrics.retention.p25;
                    patterns.avgRetentionTop.p50 += ad.videoMetrics.retention.p50;
                    patterns.avgRetentionTop.p75 += ad.videoMetrics.retention.p75;
                    patterns.avgRetentionTop.p100 += ad.videoMetrics.retention.p100;
                }
            });
            
            // Calculate averages
            const videoCount = topPerformers.filter(ad => ad.videoMetrics.retention).length;
            if (videoCount > 0) {
                Object.keys(patterns.avgRetentionTop).forEach(key => {
                    patterns.avgRetentionTop[key] = Math.round(patterns.avgRetentionTop[key] / videoCount);
                });
            }
            
            const response = {
                totalAdsAnalyzed: creativeAnalysis.length,
                lookbackPeriod: `${lookbackDays} days`,
                topPerformers: topPerformers.map(ad => ({
                    adName: ad.adName,
                    type: ad.creative.type,
                    hook: ad.creative.hook,
                    ctr: `${ad.performance.ctr.toFixed(2)}%`,
                    spend: `$${ad.performance.spend.toFixed(2)}`,
                    roas: ad.performance.roas ? `${ad.performance.roas.toFixed(2)}x` : 'N/A',
                    videoRetention: ad.videoMetrics.retention || null
                })),
                bottomPerformers: bottomPerformers.map(ad => ({
                    adName: ad.adName,
                    type: ad.creative.type,
                    hook: ad.creative.hook,
                    ctr: `${ad.performance.ctr.toFixed(2)}%`,
                    spend: `$${ad.performance.spend.toFixed(2)}`
                })),
                insights: {
                    bestPerformingType: patterns.types.VIDEO > patterns.types.IMAGE ? 'VIDEO' : 'IMAGE',
                    commonHookPatterns: Object.entries(patterns.hooks)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([hook, count]) => ({ hook, count })),
                    videoRetentionInsight: videoCount > 0 ? {
                        topPerformersAvg: patterns.avgRetentionTop,
                        recommendation: patterns.avgRetentionTop.p50 < patterns.avgRetentionTop.p25 * 0.5 
                            ? 'Hook is strong but content loses viewers. Focus on first 5 seconds.'
                            : 'Good retention throughout. Scale these video styles.'
                    } : null
                },
                recommendations: [
                    `Top performing CTR: ${topPerformers[0]?.performance.ctr.toFixed(2)}% - Replicate this creative style`,
                    patterns.types.VIDEO > patterns.types.IMAGE 
                        ? 'Video ads performing better - prioritize video content'
                        : 'Image ads performing better - test more static creatives',
                    `Test variations of these winning hooks: ${Object.keys(patterns.hooks).slice(0, 3).join(', ')}`
                ]
            };
            
            // Add notification for significant findings
            if (topPerformers[0]?.performance.ctr > 3) {
                response.notification = {
                    priority: NOTIFICATION_PRIORITY.SUCCESS,
                    message: `🎯 Found high-performing creative pattern: ${topPerformers[0].creative.hook.substring(0, 50)}... achieving ${topPerformers[0].performance.ctr.toFixed(2)}% CTR`
                };
            }
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'analyze_creative_performance',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

// 2. Automated Optimization Tool
server.registerTool(
    'execute_optimization',
    {
        title: 'Execute Optimization',
        description: 'Automatically optimize campaigns based on performance rules',
        inputSchema: z.object({
            mode: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate'),
            requireApproval: z.boolean().default(true)
        })
    },
    async ({ mode, requireApproval }) => {
        await loadState();
        try {
            const account = new AdAccount(accountId);
            
            // Define optimization rules based on mode
            const rules = {
                conservative: {
                    pauseCtrThreshold: 0.3,
                    pauseAfterSpend: 20,
                    scaleRoasThreshold: 4,
                    scaleBudgetIncrease: 1.2,
                    maxDailyBudget: 100
                },
                moderate: {
                    pauseCtrThreshold: 0.5,
                    pauseAfterSpend: 15,
                    scaleRoasThreshold: 3,
                    scaleBudgetIncrease: 1.5,
                    maxDailyBudget: 200
                },
                aggressive: {
                    pauseCtrThreshold: 0.8,
                    pauseAfterSpend: 10,
                    scaleRoasThreshold: 2.5,
                    scaleBudgetIncrease: 2.0,
                    maxDailyBudget: 500
                }
            }[mode];
            
            const optimizations = {
                paused: [],
                scaled: [],
                budgetAdjusted: [],
                audienceExpanded: []
            };
            
            // Get all active campaigns
            const campaigns = await account.getCampaigns(
                ['name', 'status', 'daily_budget', 'objective'],
                {
                    filtering: [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }],
                    limit: 100
                }
            );
            
            for (const campaign of campaigns) {
                try {
                    const insights = await campaign.getInsights(
                        ['spend', 'ctr', 'cpm', 'purchase_roas', 'frequency'],
                        { date_preset: 'last_3d' }
                    );
                    
                    const metrics = insights[0] || {};
                    const ctr = parseFloat(metrics.ctr || 0);
                    const spend = parseFloat(metrics.spend || 0);
                    const frequency = parseFloat(metrics.frequency || 0);
                    const currentBudget = parseFloat(campaign.daily_budget || 0);
                    
                    // Rule 1: Pause poor performers
                    if (ctr < rules.pauseCtrThreshold && spend > rules.pauseAfterSpend) {
                        optimizations.paused.push({
                            campaignId: campaign.id,
                            campaignName: campaign.name,
                            reason: `CTR ${ctr.toFixed(2)}% below ${rules.pauseCtrThreshold}%`,
                            metrics: { ctr, spend }
                        });
                        
                        if (!requireApproval) {
                            await campaign.update({ status: 'PAUSED' });
                        }
                    }
                    
                    // Rule 2: Scale winners (ROAS-based)
                    else if (metrics.purchase_roas) {
                        const roas = parseFloat(metrics.purchase_roas[0]?.value || 0);
                        if (roas > rules.scaleRoasThreshold && currentBudget < rules.maxDailyBudget) {
                            const newBudget = Math.min(
                                currentBudget * rules.scaleBudgetIncrease,
                                rules.maxDailyBudget
                            );
                            
                            optimizations.scaled.push({
                                campaignId: campaign.id,
                                campaignName: campaign.name,
                                reason: `ROAS ${roas.toFixed(2)}x exceeds ${rules.scaleRoasThreshold}x`,
                                currentBudget: currentBudget,
                                newBudget: newBudget,
                                metrics: { roas, ctr }
                            });
                            
                            if (!requireApproval) {
                                await campaign.update({ daily_budget: newBudget });
                            }
                        }
                    }
                    
                    // Rule 3: Scale winners (CTR-based)
                    else if (ctr > 2 && currentBudget < rules.maxDailyBudget) {
                        const newBudget = Math.min(
                            currentBudget * 1.3,
                            rules.maxDailyBudget
                        );
                        
                        optimizations.scaled.push({
                            campaignId: campaign.id,
                            campaignName: campaign.name,
                            reason: `High CTR ${ctr.toFixed(2)}%`,
                            currentBudget: currentBudget,
                            newBudget: newBudget,
                            metrics: { ctr, spend }
                        });
                        
                        if (!requireApproval) {
                            await campaign.update({ daily_budget: newBudget });
                        }
                    }
                    
                    // Rule 4: Audience fatigue
                    if (frequency > 5 && ctr < 1) {
                        optimizations.audienceExpanded.push({
                            campaignId: campaign.id,
                            campaignName: campaign.name,
                            reason: `High frequency ${frequency.toFixed(2)} with low CTR`,
                            recommendation: 'Expand audience or refresh creative',
                            metrics: { frequency, ctr }
                        });
                    }
                    
                } catch (error) {
                    console.error(`Error optimizing campaign ${campaign.id}:`, error);
                }
            }
            
            // Calculate total impact
            const totalSavings = optimizations.paused.reduce((sum, opt) => 
                sum + campaignState[opt.campaignId]?.dailyBudget || 0, 0
            );
            
            const totalInvestmentIncrease = optimizations.scaled.reduce((sum, opt) => 
                sum + (opt.newBudget - opt.currentBudget), 0
            );
            
            const response = {
                mode: mode,
                requireApproval: requireApproval,
                executedAt: new Date().toISOString(),
                summary: {
                    campaignsAnalyzed: campaigns.length,
                    campaignsPaused: optimizations.paused.length,
                    campaignsScaled: optimizations.scaled.length,
                    audienceFatigueDetected: optimizations.audienceExpanded.length,
                    estimatedDailySavings: `$${totalSavings.toFixed(2)}`,
                    additionalInvestment: `$${totalInvestmentIncrease.toFixed(2)}`
                },
                optimizations: optimizations,
                rules: rules
            };
            
            // Create approval request if needed
            if (requireApproval && (optimizations.paused.length > 0 || optimizations.scaled.length > 0)) {
                const approval = createApprovalRequest('EXECUTE_OPTIMIZATIONS', {
                    optimizations: optimizations,
                    impact: {
                        savings: totalSavings,
                        investment: totalInvestmentIncrease
                    }
                });
                
                response.approvalRequest = approval;
                response.notification = {
                    priority: NOTIFICATION_PRIORITY.URGENT,
                    message: formatWhatsAppMessage({
                        priority: NOTIFICATION_PRIORITY.URGENT,
                        message: `Optimization ready for ${mode} mode:\n\n` +
                                `• Pause ${optimizations.paused.length} campaigns (save $${totalSavings.toFixed(2)}/day)\n` +
                                `• Scale ${optimizations.scaled.length} campaigns (invest +$${totalInvestmentIncrease.toFixed(2)}/day)\n` +
                                `• ${optimizations.audienceExpanded.length} campaigns need audience refresh`,
                        approvalId: approval.approvalId,
                        expiresAt: approval.expiresAt
                    }, 'approval_request')
                };
            }
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response, null, 2)
                }]
            };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'execute_optimization',
                        stack: error.stack
                    }, null, 2)
                }]
            };
        } finally {
            await saveState();
        }
    }
);

// 3. Slack Integration Tool
server.registerTool(
    'format_slack_report',
    {
        title: 'Format Slack Report',
        description: 'Format performance data for Slack with rich blocks',
        inputSchema: z.object({
            reportType: z.enum(['daily', 'weekly', 'alert', 'optimization']).default('daily'),
            data: z.any()
        })
    },
    async ({ reportType, data }) => {
        try {
            let blocks = [];
            
            switch (reportType) {
                case 'daily':
                    blocks = [
                        {
                            type: "header",
                            text: {
                                type: "plain_text",
                                text: "📊 Daily Performance Report"
                            }
                        },
                        {
                            type: "section",
                            fields: [
                                {
                                    type: "mrkdwn",
                                    text: `*Total Spend:*\n$${data.spend || '0'}`
                                },
                                {
                                    type: "mrkdwn",
                                    text: `*ROAS:*\n${data.roas || 'N/A'}`
                                },
                                {
                                    type: "mrkdwn",
                                    text: `*CTR:*\n${data.ctr || '0'}%`
                                },
                                {
                                    type: "mrkdwn",
                                    text: `*CPM:*\n$${data.cpm || '0'}`
                                }
                            ]
                        },
                        {
                            type: "divider"
                        }
                    ];
                    
                    // Add top performers
                    if (data.topPerformers && data.topPerformers.length > 0) {
                        blocks.push({
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: "*🏆 Top Performers:*"
                            }
                        });
                        
                        data.topPerformers.slice(0, 3).forEach((ad, idx) => {
                            blocks.push({
                                type: "section",
                                text: {
                                    type: "mrkdwn",
                                    text: `${idx + 1}. *${ad.name}*\n   CTR: ${ad.ctr} | ROAS: ${ad.roas} | Spend: $${ad.spend}`
                                }
                            });
                        });
                    }
                    
                    // Add actions taken
                    if (data.actionsTaken && data.actionsTaken.length > 0) {
                        blocks.push({
                            type: "divider"
                        });
                        blocks.push({
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: "*🔧 Actions Taken:*\n" + data.actionsTaken.map(action => `• ${action}`).join('\n')
                            }
                        });
                    }
                    
                    // Add interactive buttons
                    blocks.push({
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "View Details"
                                },
                                value: "view_details",
                                action_id: "view_details"
                            },
                            {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "Run Optimization"
                                },
                                value: "run_optimization",
                                action_id: "run_optimization",
                                style: "primary"
                            }
                        ]
                    });
                    break;
                    
                case 'alert':
                    const alertEmoji = {
                        critical: '🚨',
                        urgent: '⚠️',
                        warning: '⚡',
                        info: 'ℹ️',
                        success: '🎉'
                    };
                    
                    blocks = [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: `${alertEmoji[data.priority] || '📢'} *${data.title}*\n\n${data.message}`
                            }
                        }
                    ];
                    
                    if (data.metrics) {
                        blocks.push({
                            type: "section",
                            fields: Object.entries(data.metrics).map(([key, value]) => ({
                                type: "mrkdwn",
                                text: `*${key}:*\n${value}`
                            }))
                        });
                    }
                    
                    if (data.requiresAction) {
                        blocks.push({
                            type: "actions",
                            elements: [
                                {
                                    type: "button",
                                    text: {
                                        type: "plain_text",
                                        text: "Approve"
                                    },
                                    value: data.approvalId,
                                    action_id: "approve_action",
                                    style: "primary"
                                },
                                {
                                    type: "button",
                                    text: {
                                        type: "plain_text",
                                        text: "Reject"
                                    },
                                    value: data.approvalId,
                                    action_id: "reject_action",
                                    style: "danger"
                                }
                            ]
                        });
                    }
                    break;
            }
            
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        blocks: blocks,
                        text: data.fallbackText || 'Facebook Ads Update'
                    }, null, 2)
                }]
            };
            
        } catch (error) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ 
                        error: error.message,
                        tool: 'format_slack_report'
                    }, null, 2)
                }]
            };
        }
    }
);

// ─── Transports ────────────────────────────────────────────────────────────
const HTTP_PORT = process.env.PORT || 3001;   // Render/Heroku set PORT

// 1) STDIO transport (CLI testing)
const stdioTransport = new StdioServerTransport();
await server.connect(stdioTransport);

// 2) Streamable-HTTP transport (handles each HTTP request)
const httpTransport = new StreamableHTTPServerTransport({
  enableJsonResponse: true,           // lets us return plain JSON
});
await server.connect(httpTransport);

// ─── Minimal Express wrapper ────────────────────────────────────────────────
import express from 'express';
const app = express();
app.use(express.json());

// All MCP calls go through this single endpoint
// POST /tool/<name>
// POST /tool/<name>
app.post('/tool/:name', async (req, res) => {
  try {
    const toolName = req.params.name;
    const tool = customToolRegistry.get(toolName);

    if (!tool) {
      return res
        .status(404)
        .json({ error: `Tool "${toolName}" not found` });
    }

    // Execute the tool and return its result
    const result = await tool.execute(req.body || {});
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});
  
// Optional: GET endpoint to test the streamable SSE mode later
app.get('/stream', (req, res) => {
  httpTransport.handleRequest(req, res);   // native SSE handler
});

// Start Express
app.listen(HTTP_PORT, () =>
  console.error(`MCP HTTP server ready on http://localhost:${HTTP_PORT}`),
);

// ─── Load initial state, final banner ──────────────────────────────────────
await loadState();
console.error('Facebook Ads MCP Server with WhatsApp Integration running...');