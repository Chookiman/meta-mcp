import dotenv from 'dotenv';
import { FacebookAdsApi, AdAccount } from 'facebook-nodejs-business-sdk';

// Load environment variables
dotenv.config();

async function testFacebookSetup() {
    console.log('🔍 Testing Facebook Setup...\n');
    
    // Check if environment variables are loaded
    if (!process.env.FB_ACCESS_TOKEN || !process.env.FB_ACCOUNT_ID) {
        console.error('❌ Missing environment variables!');
        console.log('Make sure your .env file contains:');
        console.log('FB_ACCESS_TOKEN=your_token');
        console.log('FB_ACCOUNT_ID=act_xxxxx');
        return;
    }
    
    try {
        // Initialize API
        FacebookAdsApi.init(process.env.FB_ACCESS_TOKEN);
        
        // Test account access
        const account = new AdAccount(process.env.FB_ACCOUNT_ID);
        const accountInfo = await account.read(['name', 'account_status', 'currency']);
        
        console.log('✅ Account Connected Successfully!');
        console.log(`📊 Account: ${accountInfo.name}`);
        console.log(`💰 Currency: ${accountInfo.currency}`);
        console.log(`📈 Status: ${accountInfo.account_status === 1 ? 'Active' : 'Inactive'}`);
        
        // Get recent performance
        const insights = await account.getInsights(
            ['spend', 'impressions', 'clicks', 'ctr'],
            { date_preset: 'last_7d' }
        );
        
        if (insights[0]) {
            console.log('\n📊 Last 7 Days Performance:');
            console.log(`Spend: $${insights[0].spend}`);
            console.log(`Impressions: ${insights[0].impressions}`);
            console.log(`Clicks: ${insights[0].clicks}`);
            console.log(`CTR: ${insights[0].ctr}%`);
        }
        
        console.log('\n✅ Everything is working!');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testFacebookSetup();