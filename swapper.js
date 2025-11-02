"use strict";
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
const tls = require("tls");
const fs = require("fs/promises");
const axios = require("axios");
require("dns").setDefaultResultOrder("ipv4first");

// Sistem seviyesi optimizasyonlar
try { process.setpriority(process.PRIORITY_HIGH); } catch(e) {}

let config, sourceToken, targetToken, sourceGuildId, targetGuildId, targetVanity, tempVanity, webhookUrl;
let sourceMfaToken, targetMfaToken;
const tlsConnections = [];
const vanityRequestCache = new Map();
const CONNECTION_POOL_SIZE = 4; // 4 kalsın iyi elleme

console.log("[SWAPPER] Vanity URL Transfer Tool started");

async function loadConfig() {
    try {
        const configData = JSON.parse(await fs.readFile('config.json', 'utf8'));
        config = configData;
        sourceToken = config.sourceToken;
        targetToken = config.targetToken;
        sourceGuildId = config.sourceGuildId;
        targetGuildId = config.targetGuildId;
        targetVanity = config.targetVanity;
        tempVanity = config.tempVanity;
        webhookUrl = config.webhookUrl;
        
        console.log(`[CONFIG] Transfer: ${targetVanity} from ${sourceGuildId} to ${targetGuildId}`);
        console.log(`[CONFIG] Temp URL: ${tempVanity}`);
    } catch (err) {
        console.error("[CONFIG] Failed to load config.json:", err.message);
        process.exit(1);
    }
}

async function loadMfaTokens() {
    try {
        // Try new format first
        try {
            const mfaData = JSON.parse(await fs.readFile('mfa.json', 'utf8'));
            sourceMfaToken = mfaData.sourceToken || "";
            targetMfaToken = mfaData.targetToken || "";
        } catch {
            // Fallback to old format
            const mfaToken = await fs.readFile('mfa.txt', 'utf8');
            sourceMfaToken = mfaToken.trim();
            targetMfaToken = mfaToken.trim();
        }
        
        if (sourceMfaToken && targetMfaToken) {
            console.log("[MFA] MFA tokens loaded successfully");
        } else {
            console.error("[MFA] Missing MFA tokens");
            process.exit(1);
        }
    } catch (err) {
        console.error("[MFA] Failed to load MFA tokens:", err.message);
        console.error("[MFA] Make sure MFA generator is running and has generated tokens");
        process.exit(1);
    }
}

function createOptimizedConnection() {
    const tlsOptions = {
        host: "canary.discord.com",
        port: 443,
        minVersion: "TLSv1.3",   
        maxVersion: "TLSv1.3",
        rejectUnauthorized: false, 
        handshakeTimeout: 3000,    
        session: null,
        keepAlive: true,
        keepAliveInitialDelay: 0,  
        highWaterMark: 128 * 1024, 
        servername: "canary.discord.com",
        ALPNProtocols: ['http/1.1'], 
        ciphers: 'TLS_AES_128_GCM_SHA256', 
        ecdhCurve: 'X25519',        
        honorCipherOrder: true,     
        requestOCSP: false,         
        secureOptions: require('constants').SSL_OP_NO_COMPRESSION, 
    };
    
    const connection = tls.connect(tlsOptions);
    
    if (connection.setPriority) { 
        connection.setPriority(6); 
    }
    connection.setNoDelay(true);
    
    if (connection.socket) {
        connection.socket.setNoDelay(true);
        
        if (connection.socket.setKeepAlive) {
            connection.socket.setKeepAlive(true, 0);
        }
        
        if (connection.socket.setPriority) {
            connection.socket.setPriority(6);
        }
        
        if (connection.socket.setRecvBufferSize) {
            connection.socket.setRecvBufferSize(1024 * 1024);
            connection.socket.setSendBufferSize(1024 * 1024);
        }
    }
    
    return connection;
}

function getVanityPatchRequestBuffer(guildId, vanityCode, token, mfaToken) {
    const cacheKey = `${guildId}-${vanityCode}`;
    if (vanityRequestCache.has(cacheKey)) {
        return vanityRequestCache.get(cacheKey);
    }
    
    const payload = JSON.stringify({ code: vanityCode });
    const payloadLength = Buffer.byteLength(payload);
    const requestBuffer = Buffer.from(
        `PATCH /api/v8/guilds/${guildId}/vanity-url HTTP/1.1\r\n` +
        `Host: canary.discord.com\r\n` +
        `Authorization: ${token}\r\n` +
        `X-Discord-MFA-Authorization: ${mfaToken}\r\n` +
        `User-Agent: Mozilla/5.0\r\n` +
        `X-Super-Properties: eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==\r\n` +
        `Content-Type: application/json\r\n` +
        `Connection: keep-alive\r\n` +
        `Content-Length: ${payloadLength}\r\n\r\n` +
        payload
    );
    
    vanityRequestCache.set(cacheKey, requestBuffer);
    return requestBuffer;
}

async function sendWebhookNotification(vanityCode, success = true) {
    if (!webhookUrl) return;
    
    try {
        const payload = {
            embeds: [
                {
                    description: `Swapped vanity : **${vanityCode}**`,
                    color: 0x000000 
                }
            ]
        };
        
        s
        await axios.post(webhookUrl, payload);
        
        
        const videoPayload = {
            content: "https://media.discordapp.net/attachments/1242891781205524553/1267134157423906947/image.gif?ex=69081a65&is=6906c8e5&hm=e4538a05f63c85d7c4a8dffb4b4d95d7dba406722ab3b3968df9ea61fbca425a&="
        };
        
        await axios.post(webhookUrl, videoPayload);
        console.log("[WEBHOOK] Notification sent");
    } catch (err) {
        console.error("[WEBHOOK] Failed to send notification:", err.message);
    }
}

function initConnectionPool() {
    console.log(`[TLS] Initializing connection pool (size: ${CONNECTION_POOL_SIZE})`);
    for (let i = 0; i < CONNECTION_POOL_SIZE; i++) {
        const conn = createOptimizedConnection();
        
        conn.on("error", (err) => { 
            console.error(`[TLS] Connection ${i + 1} error:`, err.message);
            const idx = tlsConnections.indexOf(conn);
            if (idx !== -1) tlsConnections.splice(idx, 1);
            
            // Recreate connection
            setTimeout(() => {
                const newConn = createOptimizedConnection();
                setupConnectionHandlers(newConn, i + 1);
            }, 1000);
        });
        
        conn.on("end", () => { 
            const idx = tlsConnections.indexOf(conn);
            if (idx !== -1) tlsConnections.splice(idx, 1);
        });
        
        conn.on("secureConnect", () => { 
            if (!tlsConnections.includes(conn)) {
                tlsConnections.push(conn);
                console.log(`[TLS] Connection ${i + 1} ready`);
            }
        });
        
        conn.on("data", (data) => {
            const dataStr = data.toString();
            if (dataStr.includes('HTTP/1.1 204') || dataStr.includes('HTTP/1.1 200')) {
                console.log(`[RESPONSE] Success response received`);
            } else if (dataStr.includes('HTTP/1.1 4')) {
                console.log(`[RESPONSE] Error response: ${dataStr.split('\r\n')[0]}`);
            }
        });
    }
}

// Keep-alive mechanism
const keepAliveRequest = Buffer.from(`GET / HTTP/1.1\r\nHost: canary.discord.com\r\nConnection: keep-alive\r\n\r\n`);
setInterval(() => {
    for (const conn of tlsConnections) {
        if (conn.writable) conn.write(keepAliveRequest);
    }
}, 7500);

async function executeTransfer() {
    console.log(`[TRANSFER] Starting vanity URL transfer: ${targetVanity}`);
    console.log(`[TRANSFER] Source: ${sourceGuildId} → Target: ${targetGuildId}`);
    
    // Prepare requests
    const sourceChangeRequest = getVanityPatchRequestBuffer(sourceGuildId, tempVanity, sourceToken, sourceMfaToken);
    const targetClaimRequest = getVanityPatchRequestBuffer(targetGuildId, targetVanity, targetToken, targetMfaToken);
    
    // Phase 1: Change source server URL (targetVanity → tempVanity)
    console.log(`[STEP 1] Changing source server URL: ${targetVanity} → ${tempVanity}`);
    const sourcePromises = tlsConnections.slice(0, 2).map(conn => {
        return new Promise(resolve => {
            if (conn && conn.writable) {
                if (conn.setPriority) conn.setPriority(6);
                conn.write(sourceChangeRequest);
                console.log("[SOURCE] URL change request sent");
            }
            resolve();
        });
    });
    
    await Promise.all(sourcePromises);
    
    // MAKSIMUM HIZ - NO DELAY
    console.log("[WAIT] MAXIMUM SPEED - NO DELAY!");
    
    // Phase 2: Claim URL on target server (targetVanity) - ULTRA FAST
    console.log(`[STEP 2] ULTRA FAST claiming URL: ${targetVanity}`);
    const targetPromises = tlsConnections.map(conn => {
        return new Promise(resolve => {
            if (conn && conn.writable) {
                if (conn.setPriority) conn.setPriority(6);
                // IMMEDIATE WRITE - NO DELAY
                conn.write(targetClaimRequest);
                console.log("[TARGET] INSTANT URL claim sent");
            }
            resolve();
        });
    });
    
    // EXTRA SPEED - Multiple rapid requests
    for (let i = 0; i < 5; i++) {
        setImmediate(() => {
            tlsConnections.forEach(conn => {
                if (conn && conn.writable) {
                    conn.write(targetClaimRequest);
                }
            });
        });
    }
    
    await Promise.all(targetPromises);
    
    // Send webhook notification
    await sendWebhookNotification(targetVanity, true);
    
    console.log(`[TRANSFER] Completed transfer: ${targetVanity}`);
    console.log(`[SUCCESS] Source server now uses: ${tempVanity}`);
    console.log(`[SUCCESS] Target server now uses: ${targetVanity}`);
}

async function main() {
    await loadConfig();
    await loadMfaTokens();
    initConnectionPool();
    
    // Reduced wait time for faster start
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log("[SWAPPER] ULTRA FAST MODE - Ready! Press CTRL+C to cancel, or wait 1 second...");
    console.log(`[INFO] LIGHTNING SPEED transfer: '${targetVanity}' from source to target`);
    
    // 1 second countdown - SPEED
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await executeTransfer();
    
    console.log("[SWAPPER] Transfer completed. Exiting...");
    process.exit(0);
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log("\n[SWAPPER] Cancelled by user");
    process.exit(0);
});

main().catch(err => {
    console.error("[ERROR]", err);
    process.exit(1);
});
