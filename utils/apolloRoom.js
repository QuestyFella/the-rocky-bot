// apollo's club room: `!buzz` rings the room (apollo's monitor shows who it is and beeps), and one
// "shop open :D" / "shop closed :(" message that someone in the room flips from apollo's keyboard.
// Turned on by APOLLO_BUZZ_CHANNEL_ID and/or APOLLO_SHOP_CHANNEL_ID. Files it shares with the monitor:
//   <APOLLO_ROOM_DIR>/buzz.json   written here on each !buzz; the monitor shows it and beeps
//   <APOLLO_ROOM_DIR>/shop.json   the shop's current state, shown on the monitor
//   APOLLO_SHOP_REQUEST_FILE      written by the monitor when someone presses S; applied here
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataPaths');

const BUZZ_COOLDOWN_MS = 10000;
const SHOP_RETRY_MS = 30000;
const shopText = open => (open ? 'shop open :D' : 'shop closed :(');

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// Readers (the monitor) never see half a file.
function writeJson(file, value) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o644 });
    fs.renameSync(temporary, file);
}

function isBuzz(content) {
    return /^!buzz(\s|$)/i.test(String(content || '').trim());
}

function roomConfig(env = process.env) {
    const id = value => (/^\d{5,25}$/.test(String(value || '').trim()) ? String(value).trim() : null);
    const buzzChannelId = id(env.APOLLO_BUZZ_CHANNEL_ID);
    const shopChannelId = id(env.APOLLO_SHOP_CHANNEL_ID);
    if (!buzzChannelId && !shopChannelId) return null;
    return {
        buzzChannelId,
        shopChannelId,
        roomDir: env.APOLLO_ROOM_DIR || '/var/lib/rocky-board',
        shopRequestFile: env.APOLLO_SHOP_REQUEST_FILE || '/run/rocky-board-kiosk/shop-request.json',
        stateFile: dataPath('apolloRoom.json'),
        pollMs: 2000
    };
}

// Returns null when neither channel is configured.
function createRoom(client, config = roomConfig(), { now = Date.now } = {}) {
    if (!config) return null;
    const state = readJson(config.stateFile) || {};   // { shop: { open, messageId, updatedAt }, lastRequestId }
    let lastBuzz = 0;
    let retryAt = 0;
    let applying = null;
    let timer = null;

    const saveState = () => writeJson(config.stateFile, state);
    const publishShop = () => {
        if (state.shop) writeJson(path.join(config.roomDir, 'shop.json'), { open: state.shop.open, updatedAt: state.shop.updatedAt });
    };

    async function buzz(message) {
        const time = now();
        if (time - lastBuzz < BUZZ_COOLDOWN_MS) {
            await message.react('⏳').catch(() => {});
            return;
        }
        lastBuzz = time;
        const name = message.member?.displayName || message.author.globalName || message.author.username;
        const note = String(message.cleanContent ?? message.content).trim().slice(5).replace(/\s+/g, ' ').trim().slice(0, 80);
        try {
            writeJson(path.join(config.roomDir, 'buzz.json'), { id: message.id, name, note, at: new Date(time).toISOString() });
        } catch (error) {
            console.error('[room] Could not ring the room:', error.message);
            await message.react('⚠️').catch(() => {});
            return;
        }
        await message.react('🔔').catch(() => {});
    }

    // One message in the shop channel, edited in place (posted again if someone deleted it).
    async function setShop(open) {
        const channel = await client.channels.fetch(config.shopChannelId);
        let message = null;
        if (state.shop?.messageId) {
            try {
                message = await channel.messages.fetch(state.shop.messageId);
            } catch (error) {
                if (error.code !== 10008) throw error;     // Unknown Message: post a new one
            }
        }
        if (message) await message.edit({ content: shopText(open) });
        else message = await channel.send({ content: shopText(open) });
        state.shop = { open, messageId: message.id, updatedAt: new Date(now()).toISOString() };
        saveState();
        publishShop();
    }

    async function applyShopRequest() {
        if (!config.shopChannelId || now() < retryAt) return;
        const request = readJson(config.shopRequestFile);
        if (!request || typeof request.open !== 'boolean' || !request.id || request.id === state.lastRequestId) return;
        try {
            if (request.open !== state.shop?.open) await setShop(request.open);
            state.lastRequestId = request.id;
            saveState();
        } catch (error) {
            retryAt = now() + SHOP_RETRY_MS;
            console.error('[room] Could not update the shop message:', error.message);
        }
    }

    // Never two at once, so a slow Discord edit can't be applied twice.
    function checkShop() {
        applying ||= applyShopRequest().finally(() => { applying = null; });
        return applying;
    }

    return {
        checkShop,
        start() {
            try {
                publishShop();
            } catch (error) {
                console.error('[room] Could not publish the shop state:', error.message);
            }
            if (config.shopChannelId && !timer) {
                timer = setInterval(checkShop, config.pollMs);
                timer.unref?.();
            }
        },
        stop() {
            clearInterval(timer);
            timer = null;
        },
        // Called for every Discord message; returns true for a !buzz it handled.
        fromDiscord(message) {
            if (!config.buzzChannelId || message.channelId !== config.buzzChannelId || message.author?.bot || !isBuzz(message.content)) return false;
            buzz(message).catch(error => console.error('[room] Buzz failed:', error.message));
            return true;
        }
    };
}

module.exports = { createRoom, roomConfig, isBuzz, shopText };
