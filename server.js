const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// html/js 永不缓存，避免客户端运行旧版本；媒体文件正常缓存
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));

const ATTRIBUTES = ['金', '木', '水', '火', '土', '幽'];
const TEAM_MAP = { 1: 4, 4: 1, 2: 5, 5: 2, 3: 6, 6: 3 };

let gameState = {
    status: 'LOBBY', 
    hostUuid: null,     // 🌟 新增：记录房主UUID
    slots: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
    players: {},        
    tableCards: [],     
    pickupZone: [],     
    lastValidPower: 0,
    currentPlayerIndex: 0,
    exchangeData: {},
    turnStarter: 1,
    passCount: 0,
    lastPlayerSlot: null, 
    isFirstTurn: true,    
    readyPlayers: [], 
    lastPickedAction: null,    
    lastRoundResults: []  
};

function logger(action, msg) {
    console.log(`\x1b[36m[${new Date().toLocaleTimeString()}]\x1b[0m \x1b[33m${action}:\x1b[0m ${msg}`);
}

// --- 辅助函数 ---
function updateHost() {
    // 如果当前没有房主，或者房主不在玩家列表里
    if (!gameState.hostUuid || !gameState.players[gameState.hostUuid]) {
        // 找一个最早加入的或者座位号最小的玩家当房主
        const remainingUuids = Object.keys(gameState.players);
        if (remainingUuids.length > 0) {
            // 这里简单策略：选第一个（通常是座位号靠前的）
            gameState.hostUuid = remainingUuids[0];
            const p = gameState.players[gameState.hostUuid];
            logger('系统', `房主变更为: P${p.slot} [${p.nickname}]`);
        } else {
            gameState.hostUuid = null;
        }
    }
}

function calculatePower(cards) {
    if (!cards || cards.length === 0) return 0;
    let vals = cards.map(c => c.value).sort((a, b) => {
        if (a === 10) return -1;
        if (b === 10) return 1;
        return b - a;
    });
    return parseInt(vals.join(''));
}

function sortCards(cards) {
    return cards.sort((a, b) => {
        if (a.value === 10 && b.value !== 10) return -1;
        if (a.value !== 10 && b.value === 10) return 1;
        return b.value - a.value;
    });
}

function isValidCombo(cards) {
    if (cards.length === 0) return false;
    const allSameAttr = cards.every(c => c.attr === cards[0].attr);
    const allSameVal = cards.every(c => c.value === cards[0].value);
    return allSameAttr || allSameVal;
}

// --- Socket 逻辑 ---
io.on('connection', (socket) => {
    // 🌟 1. 连接注册/重连检测
    socket.on('register_connection', (uuid) => {
        const player = gameState.players[uuid];
        if (player) {
            // 是老玩家重连
            player.socketId = socket.id; // 更新 Socket ID
            player.online = true;        // 标记在线
            logger('重连', `玩家 ${player.nickname} 回到了游戏`);
            socket.emit('msg', '欢迎回来！已同步最新状态。');
        }
        // 无论是否重连，都发送当前状态
        socket.emit('sync', gameState);
    });

    // 🌟 2. 断开连接 (心跳检测失败)
    socket.on('disconnect', () => {
        // 找到是哪个玩家断开了
        const uuid = Object.keys(gameState.players).find(u => gameState.players[u].socketId === socket.id);
        if (uuid) {
            gameState.players[uuid].online = false; // 标记离线
            logger('离线', `玩家 ${gameState.players[uuid].nickname} 掉线了`);
            io.emit('sync', gameState); // 通知其他人他掉线了
        }
    });

    // 3. 入座
    socket.on('join_slot', ({ slotIndex, uuid, nickname }) => {
        const slotNum = parseInt(slotIndex);
        if (gameState.slots[slotNum]) return socket.emit('msg', '座位已满');

        // 清理该 UUID 之前的座位（如果有）
        for (let s in gameState.slots) if (gameState.slots[s] === uuid) gameState.slots[s] = null;

        gameState.slots[slotNum] = uuid;
        gameState.players[uuid] = {
            slot: slotNum,
            nickname: nickname || `P${slotNum}`,
            socketId: socket.id,
            online: true, // 🌟 初始在线
            cards: [],
            seal: 0,
            exchanged: false,
            team: (slotNum == 1 || slotNum == 4) ? 'A' : (slotNum == 2 || slotNum == 5) ? 'B' : 'C'
        };

        // 如果还没有房主，这个人就是房主
        if (!gameState.hostUuid) {
            gameState.hostUuid = uuid;
            logger('房主', `${nickname} 成为了房主`);
        }

        logger('入座', `${nickname} -> 座位 ${slotNum}`);
        io.emit('sync', gameState);
        if (Object.values(gameState.slots).every(s => s !== null)) startNewRound();
    });

    // 🌟 4. 踢人 (房主特权)
    socket.on('kick_player', ({ uuid, targetUuid }) => {
        if (gameState.hostUuid !== uuid) return socket.emit('msg', '只有房主可以踢人');
        if (gameState.status !== 'LOBBY') return socket.emit('msg', '游戏中无法踢人');
        
        const target = gameState.players[targetUuid];
        if (!target) return;

        logger('踢出', `房主踢出了 ${target.nickname}`);
        
        // 清理数据
        gameState.slots[target.slot] = null;
        delete gameState.players[targetUuid];
        
        // 如果踢的是自己（虽然前端一般不让），由于 delete 了，下面 updateHost 会处理
        updateHost();

        io.emit('sync', gameState);
        io.emit('msg', `${target.nickname} 被房主移出了房间`);
    });

    // ... (以下是之前的游戏逻辑，几乎未变) ...
    // 5. 交换手牌
    socket.on('exchange_card', ({ uuid, card }) => {
        const player = gameState.players[uuid];
        if (!player || player.exchanged) return;
        const cardIndex = player.cards.findIndex(c => c.id === card.id);
        if (cardIndex === -1) return;
        const removedCard = player.cards.splice(cardIndex, 1)[0];
        player.exchanged = true;
        gameState.exchangeData[player.slot] = removedCard;
        
        if (Object.keys(gameState.exchangeData).length === 6) {
            for (let senderSlot = 1; senderSlot <= 6; senderSlot++) {
                const targetUuid = gameState.slots[TEAM_MAP[senderSlot]];
                if (gameState.players[targetUuid]) {
                    gameState.players[targetUuid].cards.push(gameState.exchangeData[senderSlot]);
                }
                gameState.players[gameState.slots[senderSlot]].exchanged = false;
            }
            gameState.exchangeData = {};
            gameState.status = 'PLAYING';
            gameState.currentPlayerIndex = gameState.turnStarter - 1;
            gameState.tableCards = [];
            gameState.pickupZone = [];
            gameState.lastValidPower = 0;
            gameState.passCount = 0;
            gameState.lastPlayerSlot = null;
            gameState.isFirstTurn = true;
            io.emit('msg', '交换完成！游戏开始');
            io.emit('sync', gameState);
        } else {
            io.emit('sync', gameState);
        }
    });

    socket.on('reorder_hand', ({ uuid, newOrderIds }) => {
        const player = gameState.players[uuid];
        if (!player) return;
        const currentIds = player.cards.map(c => c.id);
        if (!newOrderIds || newOrderIds.length !== currentIds.length) return;
        let newHand = [];
        for (let id of newOrderIds) {
            const card = player.cards.find(c => c.id === id);
            if (card) newHand.push(card); else return; 
        }
        player.cards = newHand;
        socket.emit('sync', gameState);
    });

    socket.on('play_cards', ({ uuid, selectedCards }) => {
        const player = gameState.players[uuid];
        if (gameState.slots[gameState.currentPlayerIndex + 1] !== uuid) return socket.emit('msg', '不是你的回合');
        const power = calculatePower(selectedCards);
        const isValid = isValidCombo(selectedCards);
        gameState.lastPickedAction = null;
        if (!isValid) return socket.emit('msg', '规则错误：必须同属性或同点数');

        if (gameState.tableCards.length === 0) {
            if (gameState.isFirstTurn) {
                if (selectedCards.length !== 1) return socket.emit('msg', '开局第一手只能出1张');
            } else {
                if (selectedCards.length > 1 && player.cards.length > selectedCards.length) {
                    return socket.emit('msg', '领出限制：只能出1张或全出');
                }
            }
        } else {
            if (power <= gameState.lastValidPower) return socket.emit('msg', `力量不足！你需要大于 ${gameState.lastValidPower}，当前仅为 ${power}`);
        }

        const cardIds = selectedCards.map(c => c.id);
        player.cards = player.cards.filter(c => !cardIds.includes(c.id));
        const sortedTableCards = sortCards(selectedCards);
        logger('出牌', `P${player.slot} 打出 [${sortedTableCards.length}张]`);

        let cardsToPickup = [...gameState.tableCards];
        gameState.tableCards = sortedTableCards;
        gameState.lastValidPower = power;
        gameState.passCount = 0;
        gameState.lastPlayerSlot = player.slot;
        gameState.isFirstTurn = false;

        if (player.cards.length === 0) {
            endRound(uuid);
        } else if (cardsToPickup.length > 0) {
            gameState.status = 'PICKING';
            gameState.pickupZone = cardsToPickup; 
            socket.emit('pick_required', cardsToPickup);
            io.emit('sync', gameState);
        } else {
            nextTurn();
            io.emit('sync', gameState);
        }
    });

// --- 3. 拾取 (picked_card) ---
    socket.on('picked_card', ({ uuid, cardId }) => {
        if (gameState.status !== 'PICKING') return;
        const player = gameState.players[uuid];
        
        const idx = gameState.pickupZone.findIndex(c => c.id === cardId);
        if (idx !== -1) {
            const card = gameState.pickupZone[idx];
            player.cards.push(card);
            
            // 🌟 新增：记录这次操作，供前端展示
            gameState.lastPickedAction = {
                nickname: player.nickname,
                card: card
            };
            
            logger('拾取', `P${player.slot} 拿回了 [${card.attr}${card.value}]`);
        }
        
        gameState.pickupZone = [];
        gameState.status = 'PLAYING';
        nextTurn();
        io.emit('sync', gameState);
    });

socket.on('pass', ({uuid}) => {
        if (gameState.slots[gameState.currentPlayerIndex + 1] !== uuid) return; // 防骚扰：不是你的回合，按了没用
        
        gameState.passCount++;
        
        // 🌟 新增：广播音效，让所有人听到 "要不起"
        io.emit('trigger_audio', { sound: 'pass' }); 

        if (gameState.passCount >= 5) {
            const winnerSlot = gameState.lastPlayerSlot;
            io.emit('msg', `无人压制，P${winnerSlot} 继续领出！`);
            gameState.tableCards = [];
            gameState.pickupZone = [];
            gameState.lastPickedAction = null; // 🌟 新增：清台时也顺便清除记录
            gameState.lastValidPower = 0;
            gameState.passCount = 0;
            if (winnerSlot) gameState.currentPlayerIndex = winnerSlot - 1;
            else nextTurn();
        } else {
            nextTurn();
        }
        io.emit('sync', gameState);
    });

    socket.on('player_ready', ({ uuid }) => {
        if (gameState.status !== 'ROUND_OVER') return;
        if (!gameState.readyPlayers.includes(uuid)) {
            gameState.readyPlayers.push(uuid);
        }
        io.emit('sync', gameState);
        if (gameState.readyPlayers.length === 6) startNewRound();
    });
});

function startNewRound() {
    logger('流程', '=== 新回合开始 ===');
    let deck = [];
    ATTRIBUTES.forEach(a => { for(let i=1;i<=10;i++) deck.push({attr:a, value:i, id:Math.random().toString(36).substr(2,6)}) });
    deck.sort(() => Math.random() - 0.5);

    gameState.status = 'EXCHANGING';
    gameState.exchangeData = {};
    gameState.tableCards = [];
    gameState.pickupZone = [];
    gameState.lastValidPower = 0;
    gameState.passCount = 0;
    gameState.lastPlayerSlot = null;
    gameState.isFirstTurn = true;
    gameState.readyPlayers = [];
    
    Object.keys(gameState.players).forEach(uuid => {
        gameState.players[uuid].cards = deck.splice(0, 10);
        gameState.players[uuid].exchanged = false;
    });
    io.emit('sync', gameState);
}

function nextTurn() {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % 6;
}

function endRound(winnerUuid) {
    const winner = gameState.players[winnerUuid];
    
    // 1. 设置下一局首发
    gameState.turnStarter = winner.slot; 
    logger('结算', `本局胜者: P${winner.slot}，下局首发`);

    // --- 🌟 新增：定向广播胜利音效 (只发给获胜者和他的队友) ---
    const winningTeam = winner.team;
    Object.values(gameState.players).forEach(p => {
        // 判断是否是获胜队伍，并且玩家在线
        if (p.team === winningTeam && p.socketId) {
            io.to(p.socketId).emit('trigger_audio', { sound: 'win' });
        }
    });
    // -----------------------------------------------------

    // 2. 结算每人手牌并生成报表
    gameState.lastRoundResults = [];
    Object.values(gameState.players).forEach(p => {
        const added = p.cards.length; // 手牌数即为增加的妖印
        p.seal += added;
        gameState.lastRoundResults.push({
            slot: p.slot, 
            nickname: p.nickname, 
            added: added, 
            total: p.seal
        });
    });
    
    // 3. 胜者减免 (赢家所在队伍少加2分，即-2)
    winner.seal -= 2;
    // 修正报表中显示的总分
    const winnerRes = gameState.lastRoundResults.find(r => r.slot === winner.slot);
    if(winnerRes) winnerRes.total = winner.seal;

    // 4. 计算各队总分，判断是否彻底结束
    const getSeal = (slot) => gameState.players[gameState.slots[slot]]?.seal || 0;
    const scores = {
        A: getSeal(1) + getSeal(4),
        B: getSeal(2) + getSeal(5),
        C: getSeal(3) + getSeal(6)
    };

    if (Object.values(scores).some(s => s >= 50)) {
        // --- 游戏彻底结束 ---
        const ranking = Object.entries(scores).sort((a,b) => a[1]-b[1]);
        const msg = `🏆 试炼终结 🏆\n\n🥇 第一名: 队${ranking[0][0]}\n🥈 第二名: 队${ranking[1][0]}\n🥉 第三名: 队${ranking[2][0]}`;
        io.emit('msg', msg);
        
        // 重置游戏，保留房主
        const host = gameState.hostUuid;
        gameState.status = 'LOBBY';
        gameState.slots = {1:null, 2:null, 3:null, 4:null, 5:null, 6:null};
        gameState.players = {}; 
        
        // 尝试让房主重新入座(或者完全重置)
        // 这里简单处理：完全重置数据，房主需要重新加入
        gameState.hostUuid = null; 
    } else {
        // --- 本局结束，进入等待界面 ---
        gameState.status = 'ROUND_OVER';
        gameState.readyPlayers = [];
    }
    
    // 5. 同步状态
    io.emit('sync', gameState);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`SERVER RUNNING ON PORT ${PORT}`));