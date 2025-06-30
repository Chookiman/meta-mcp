#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';

// Get command from arguments
const command = process.argv[2];
const args = process.argv.slice(3);

// Parse arguments into object
const parsedArgs = {};
for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];
    
    // Try to parse JSON values
    try {
        parsedArgs[key] = JSON.parse(value);
    } catch {
        parsedArgs[key] = value;
    }
}

// Create request
const request = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
        name: command,
        arguments: parsedArgs
    },
    id: 1
};

// Spawn MCP server
const mcp = spawn('node', [path.join(process.cwd(), 'src/facebook-mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'inherit']
});

// Send request
mcp.stdin.write(JSON.stringify(request) + '\n');

// Collect response
let responseData = '';
mcp.stdout.on('data', (data) => {
    responseData += data.toString();
});

// Process response
mcp.stdout.on('end', () => {
    try {
        const response = JSON.parse(responseData);
        if (response.result?.content?.[0]?.text) {
            // Output the actual content for n8n
            console.log(response.result.content[0].text);
        } else {
            console.log(JSON.stringify(response));
        }
    } catch (error) {
        console.error('Error parsing response:', error);
        console.log(responseData);
    }
    process.exit(0);
});

// Handle errors
mcp.on('error', (error) => {
    console.error('MCP Error:', error);
    process.exit(1);
});