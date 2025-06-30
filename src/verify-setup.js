import { FacebookAdsApi, AdAccount } from 'facebook-nodejs-business-sdk';

// Your credentials (remember to change these later!)
const config = {
    appId: '1066135801653289',
    appSecret: '7f9ed4599b6f800fcf4ec6a2553c612a',
    accessToken: 'EAAPJpRW9aCkBO6PJFBB7sPYWTXMSZA4nRRTYOHGuqiYTV9cCMRwevL3pZCQZAE0HrDZCEofvYBDZBZC2mGCK7QQrXBV9n0HEdOCHKxdIlosuM0tNA3BYcLtul4QZBG7NDgxVY8vZAZBY4YXoGZCr6QjqSB9WS9H5O9pIuL0eqSZBFI7z2E7ZA0LxND2V2gyRSgIB1ylc', // Replace with the token from step 1
    adAccountId: 'act_618670207567525' // You'll get this from step 2
};

async function verifySetup() {
    console.log('🔍 Verifying Facebook Ads Setup...\n');
    
    try {
        // Initialize API
        FacebookAdsApi.init(config.accessToken);
        
        // Test 1: Verify token
        const debugToken = await FacebookAdsApi.get('/debug_token', {
            input_token: config.accessToken,
            access_token: `${config.appId}|${config.appSecret}`
        });
        
        console.log('✅ Token is valid');
        console.log(`📱 App ID: ${debugToken.data.app_id}`);
        console.log(`👤 User ID: ${debugToken.data.user_id}`);
        
        if (debugToken.data.expires_at) {
            const expiresDate = new Date(debugToken.data.expires_at * 1000);
            const daysLeft = Math.floor((expiresDate - new Date()) / (1000 * 60 * 60 * 24));
            console.log(`⏰ Token expires in ${daysLeft} days`);
        }
        
        // Test 2: Get ad accounts
        const accounts = await FacebookAdsApi.get('/me/adaccounts', {
            fields: 'id,name,account_status,currency,balance,spend_cap'
        });
        
        console.log('\n📊 Your Ad Accounts:');
        accounts.data.forEach(account => {
            console.log(`\nAccount: ${account.name}`);
            console.log(`ID: ${account.id}`);
            console.log(`Status: ${account.account_status === 1 ? '✅ Active' : '❌ Inactive'}`);
            console.log(`Currency: ${account.currency}`);
            if (account.balance) {
                console.log(`Balance: ${(parseInt(account.balance) / 100).toFixed(2)} ${account.currency}`);
            }
        });
        
        // Test 3: Get a sample of campaigns
        if (accounts.data.length > 0) {
            const accountId = accounts.data[0].id;
            console.log(`\n📈 Checking campaigns for account ${accountId}...`);
            
            const account = new AdAccount(accountId);
            const campaigns = await account.getCampaigns(
                ['name', 'status', 'objective', 'daily_budget', 'lifetime_budget'],
                { limit: 5 }
            );
            
            if (campaigns.length > 0) {
                console.log('\nSample Campaigns:');
                campaigns.forEach(campaign => {
                    console.log(`- ${campaign.name} (${campaign.status})`);
                });
            } else {
                console.log('No campaigns found in this account');
            }
            
            console.log(`\n💡 Use this account ID in your .env file:`);
            console.log(`FB_AD_ACCOUNT_ID=${accountId}`);
        }
        
        console.log('\n🎉 Everything is working! Ready to build your agent.');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.log('\nTroubleshooting:');
        
        if (error.message.includes('Invalid OAuth')) {
            console.log('- Your token might be invalid or expired');
            console.log('- Make sure you used the long-lived token from step 1');
        } else if (error.message.includes('permissions')) {
            console.log('- Your app might be missing required permissions');
            console.log('- Check App Review → Permissions in your app dashboard');
        }
    }
}

// Run verification
verifySetup();