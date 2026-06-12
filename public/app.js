import * as THREE from './vendor/three.module.js';

/* =========================================================================
   妖印试炼 · 3D client
   - server.js / socket protocol is unchanged
   - this module renders the table, players and cards in three.js, and keeps
     the lobby / controls / modals as the HTML overlay defined in index.html
   ========================================================================= */

/* surface any runtime error on screen instead of failing silently */
window.addEventListener('error', (e) => {
    const bar = document.getElementById('status-bar');
    if (bar) { bar.style.display = 'block'; bar.style.color = '#ff6b6b'; bar.innerText = '⚠ ' + (e.message || 'error'); }
});
function webglSupported() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
}
if (!webglSupported()) {
    document.body.innerHTML = '<div style="color:#eee;padding:48px;text-align:center;font-family:serif;font-size:18px;line-height:1.7">' +
        '您的浏览器不支持 WebGL，无法运行 3D 版本。<br>请改用最新版 Chrome / Edge / Safari。</div>';
    throw new Error('WebGL not supported');
}

const socket = io();
const myUUID = localStorage.getItem('uuid') || 'u' + Math.random().toString(36).substr(2, 8);
localStorage.setItem('uuid', myUUID);

let lastState = null;
let selectedIds = [];
let handOrder = [];          // current display order of my hand (ids)

/* ----------------------------- audio ----------------------------- */
const sounds = {
    click: new Audio('click.mp3'),
    play:  new Audio('play.mp3'),
    turn:  new Audio('ding.mp3'),
    win:   new Audio('cheer.mp3'),
    pass:  new Audio('pass.wav')
};
let lastSoundTime = 0;
function playSound(name) {
    const now = Date.now();
    if (now - lastSoundTime < 120) return;
    if (sounds[name]) {
        lastSoundTime = now;
        sounds[name].currentTime = 0;
        sounds[name].play().catch(() => {});
    }
}

/* ===================================================================
   THREE.JS SCENE SETUP
   =================================================================== */
const ATTR_COLORS = {
    '金': ['#f7d046', '#a17e09'],
    '木': ['#3ee07f', '#176b39'],
    '水': ['#4aa8f0', '#1a4e78'],
    '火': ['#ff6b5e', '#a32a1e'],
    '土': ['#a3826f', '#3e2a1e'],
    '幽': ['#4a4a4a', '#050505']
};
const ATTR_TEXT = { '金': '#5a4a05', '木': '#fff', '水': '#fff', '火': '#fff', '土': '#fff', '幽': '#d2b4de' };
const TEAM_COLORS = { A: '#e74c3c', B: '#3498db', C: '#2ecc71' };

const CARD_W = 1.0, CARD_H = 1.5, CARD_D = 0.04;
const SEAT_RADIUS = 6.6;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.autoClear = false;
renderer.domElement.id = 'scene-canvas';
renderer.domElement.style.touchAction = 'none';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#04140c');
scene.fog = new THREE.Fog('#04140c', 16, 30);

/* perspective camera frames the table + opponents (upper part of screen) */
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
function placeCamera() {
    const portrait = window.innerHeight > window.innerWidth;
    camera.position.set(0, portrait ? 12 : 10, portrait ? 12.5 : 12);
    camera.lookAt(0, 0, -0.8);
}
placeCamera();

/* orthographic HUD layer renders the player's own hand on top of the 3D
   scene, so it is always visible & tappable regardless of aspect ratio */
const handScene = new THREE.Scene();
const HUD = { H: 12, W: 12 };
const handCamera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.1, 100);
handCamera.position.set(0, 0, 10);
function sizeHud() {
    const aspect = window.innerWidth / window.innerHeight;
    HUD.W = HUD.H * aspect;
    handCamera.left = -HUD.W / 2; handCamera.right = HUD.W / 2;
    handCamera.top = HUD.H / 2; handCamera.bottom = -HUD.H / 2;
    handCamera.updateProjectionMatrix();
}
sizeHud();

/* lights */
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xfff2d0, 1.1);
key.position.set(-6, 14, 8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fd0ff, 0.4);
rim.position.set(8, 6, -10);
scene.add(rim);
const spot = new THREE.PointLight(0xffe9b0, 0.9, 40, 2);
spot.position.set(0, 9, 0);
scene.add(spot);

/* hexagonal table */
const tableGroup = new THREE.Group();
scene.add(tableGroup);
{
    const top = new THREE.Mesh(
        new THREE.CylinderGeometry(5, 5, 0.5, 6),
        new THREE.MeshStandardMaterial({ color: 0x0e5c37, roughness: 0.95, metalness: 0.0 })
    );
    top.position.y = -0.25;
    top.rotation.y = Math.PI / 6;
    tableGroup.add(top);

    const rim2 = new THREE.Mesh(
        new THREE.CylinderGeometry(5.45, 5.6, 0.7, 6),
        new THREE.MeshStandardMaterial({ color: 0x3a2417, roughness: 0.6, metalness: 0.2 })
    );
    rim2.position.y = -0.45;
    rim2.rotation.y = Math.PI / 6;
    tableGroup.add(rim2);

    // glowing center disc where cards are played
    const disc = new THREE.Mesh(
        new THREE.CircleGeometry(2.6, 48),
        new THREE.MeshStandardMaterial({ color: 0x0a3d24, roughness: 1.0, emissive: 0x06301c, emissiveIntensity: 0.5 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.01;
    tableGroup.add(disc);

    const ring = new THREE.Mesh(
        new THREE.RingGeometry(2.55, 2.75, 64),
        new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    tableGroup.add(ring);
}

/* ===================================================================
   TEXTURES
   =================================================================== */
const _cardTexCache = new Map();
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
function makeCardFaceTexture(attr, value) {
    const k = attr + value;
    if (_cardTexCache.has(k)) return _cardTexCache.get(k);
    const W = 256, H = 384;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const [c1, c2] = ATTR_COLORS[attr];
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.fillStyle = g; roundRect(ctx, 6, 6, W - 12, H - 12, 26); ctx.fill();
    // inner frame
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3;
    roundRect(ctx, 18, 18, W - 36, H - 36, 18); ctx.stroke();

    const txt = ATTR_TEXT[attr];
    ctx.fillStyle = txt;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;

    ctx.font = '700 150px "Noto Serif SC", serif';
    ctx.fillText(attr, W / 2, H / 2 - 28);
    ctx.font = '700 84px "Noto Serif SC", serif';
    ctx.fillText(value, W / 2, H / 2 + 96);

    // corner pips
    ctx.shadowBlur = 0;
    ctx.font = '700 40px "Noto Serif SC", serif';
    ctx.textAlign = 'left';  ctx.fillText(attr + value, 26, 44);
    ctx.textAlign = 'right'; ctx.fillText(attr + value, W - 26, H - 44);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    _cardTexCache.set(k, tex);
    return tex;
}

let _backTex = null;
function makeBackTexture() {
    if (_backTex) return _backTex;
    const W = 256, H = 384;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#3a1d4a'); g.addColorStop(1, '#160a20');
    ctx.fillStyle = g; roundRect(ctx, 6, 6, W - 12, H - 12, 26); ctx.fill();
    ctx.strokeStyle = '#b07fe0'; ctx.lineWidth = 4;
    roundRect(ctx, 20, 20, W - 40, H - 40, 18); ctx.stroke();
    ctx.strokeStyle = 'rgba(176,127,224,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 78, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 64, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e6c8ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#b07fe0'; ctx.shadowBlur = 14;
    ctx.font = '700 120px "Ma Shan Zheng","Noto Serif SC", serif';
    ctx.fillText('妖', W / 2, H / 2 + 6);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    _backTex = tex;
    return tex;
}

/* ===================================================================
   CARD MESHES
   =================================================================== */
const _cardGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D);
const _edgeMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.8 });

function buildCardMesh(card) {
    const face = new THREE.MeshStandardMaterial({ map: makeCardFaceTexture(card.attr, card.value), roughness: 0.55 });
    const back = new THREE.MeshStandardMaterial({ map: makeBackTexture(), roughness: 0.55 });
    // material order: +x,-x,+y,-y,+z(front),-z(back)
    const mesh = new THREE.Mesh(_cardGeo, [_edgeMat, _edgeMat, _edgeMat, _edgeMat, face, back]);
    mesh.userData.card = card;
    return mesh;
}
function buildBackMesh() {
    const back = new THREE.MeshStandardMaterial({ map: makeBackTexture(), roughness: 0.55 });
    return new THREE.Mesh(_cardGeo, [_edgeMat, _edgeMat, _edgeMat, _edgeMat, back, back]);
}

/* HUD hand cards: flat planes with unlit (MeshBasic) faces so they are always
   bright & readable, plus a gold glow plane behind that toggles when selected */
const HAND_CARD_W = 1.5, HAND_CARD_H = 2.25;
const _handGeo = new THREE.PlaneGeometry(HAND_CARD_W, HAND_CARD_H);
const _glowGeo = new THREE.PlaneGeometry(HAND_CARD_W + 0.22, HAND_CARD_H + 0.22);
function buildHandCard(card) {
    const m = new THREE.Mesh(_handGeo, new THREE.MeshBasicMaterial({ map: makeCardFaceTexture(card.attr, card.value) }));
    m.userData.card = card;
    const glow = new THREE.Mesh(_glowGeo, new THREE.MeshBasicMaterial({ color: 0xffd700 }));
    glow.position.z = -0.02;
    glow.visible = false;
    m.add(glow);
    m.userData.glow = glow;
    return m;
}

/* tween bookkeeping: every managed mesh gets userData.tPos / tQuat / tScale */
const SPAWN = new THREE.Vector3(0, 5, 0);
const _dummy = new THREE.Object3D();

function setTarget(mesh, pos, quat, scale = 1) {
    mesh.userData.tPos = pos;
    mesh.userData.tQuat = quat;
    mesh.userData.tScale = scale;
}
function quatFromEuler(x, y, z) {
    _dummy.rotation.set(x, y, z);
    return _dummy.quaternion.clone();
}

/* ===================================================================
   STATE -> SCENE reconciliation
   =================================================================== */
const handMeshes = new Map();     // id -> mesh
const tableMeshes = new Map();    // id -> mesh
const opponents = new Map();      // slot -> { group, avatar, tex, backs:[] }

function disposeMesh(mesh) {
    scene.remove(mesh);
    // shared geo/edge mats are reused; only face/back map materials are unique
    if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => { if (m !== _edgeMat) { /* keep cached face tex */ } });
    }
}
function fadeRemove(mesh, map, id) {
    setTarget(mesh, SPAWN.clone(), mesh.quaternion.clone(), 0.01);
    mesh.userData.dead = true;
    setTimeout(() => { disposeMesh(mesh); }, 380);
    map.delete(id);
}

/* my hand (orthographic HUD layer) */
function handSpacing(n) {
    const maxSpan = HUD.W - HAND_CARD_W - 0.3;
    return n > 1 ? Math.min(HAND_CARD_W + 0.18, maxSpan / (n - 1)) : 0;
}
function layoutHand(cards, status) {
    const ids = cards.map(c => c.id);
    // create new (spawn just below the screen, slide up)
    cards.forEach(c => {
        if (!handMeshes.has(c.id)) {
            const m = buildHandCard(c);
            m.position.set(0, -HUD.H, 0);
            handMeshes.set(c.id, m);
            handScene.add(m);
        }
    });
    // remove gone (slide up & off, then dispose)
    [...handMeshes.keys()].forEach(id => {
        if (!ids.includes(id)) {
            const m = handMeshes.get(id);
            m.userData.tPos = new THREE.Vector3(m.position.x, HUD.H + 2, m.position.z);
            setTimeout(() => handScene.remove(m), 360);
            handMeshes.delete(id);
        }
    });

    // keep handOrder in sync with server order, preserving any local drag order
    handOrder = handOrder.filter(id => ids.includes(id));
    ids.forEach(id => { if (!handOrder.includes(id)) handOrder.push(id); });

    const n = handOrder.length;
    const spacing = handSpacing(n);
    const baseY = -HUD.H / 2 + HAND_CARD_H / 2 + 0.45;
    handOrder.forEach((id, i) => {
        const m = handMeshes.get(id);
        if (!m) return;
        const off = i - (n - 1) / 2;
        const sel = selectedIds.includes(id);
        m.userData.tPos = new THREE.Vector3(off * spacing, baseY - Math.abs(off) * 0.05 + (sel ? 1.15 : 0), sel ? 0.5 : 0);
        m.userData.tRot = -off * 0.03;
        m.userData.tScale = sel ? 1.12 : 1;
        m.renderOrder = i;
        if (m.userData.glow) m.userData.glow.visible = sel;
    });
}

/* center / table cards laid flat, face up */
function layoutTable(cards) {
    const ids = cards.map(c => c.id);
    cards.forEach(c => {
        if (!tableMeshes.has(c.id)) {
            const m = buildCardMesh(c);
            m.position.copy(SPAWN);
            m.scale.setScalar(0.01);
            tableMeshes.set(c.id, m);
            scene.add(m);
        }
    });
    [...tableMeshes.keys()].forEach(id => {
        if (!ids.includes(id)) fadeRemove(tableMeshes.get(id), tableMeshes, id);
    });

    const n = cards.length;
    const spacing = Math.min(1.15, 4.6 / Math.max(n, 1));
    cards.forEach((c, i) => {
        const m = tableMeshes.get(c.id);
        const off = i - (n - 1) / 2;
        const pos = new THREE.Vector3(off * spacing, 0.06 + i * 0.012, 0);
        // flat, face up: rotate -90deg about X so +Z(front) points up
        setTarget(m, pos, quatFromEuler(-Math.PI / 2, 0, off * 0.04), 1);
    });
}

/* opponents (everyone except me) */
function seatAngle(relPos) {
    // relPos 0 = me (front, +Z). go clockwise around the hex.
    return Math.PI / 2 + relPos * (Math.PI * 2 / 6);
}
function makeAvatarTexture(p, isHost, isActive) {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    const team = TEAM_COLORS[p.team] || '#888';
    const offline = p.online === false;

    // panel
    ctx.fillStyle = 'rgba(10,22,16,0.82)';
    roundRect(ctx, 14, 60, S - 28, 150, 22); ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = isActive ? '#ffd54a' : team;
    if (isActive) { ctx.shadowColor = '#ffd54a'; ctx.shadowBlur = 30; }
    roundRect(ctx, 14, 60, S - 28, 150, 22); ctx.stroke();
    ctx.shadowBlur = 0;

    // avatar circle
    ctx.beginPath(); ctx.arc(S / 2, 60, 46, 0, Math.PI * 2);
    ctx.fillStyle = offline ? '#444' : team; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '700 48px "Noto Serif SC", serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((p.nickname || '?').charAt(0), S / 2, 60);

    // name
    ctx.font = '600 30px "Noto Serif SC", serif';
    ctx.fillStyle = offline ? '#888' : '#fff';
    let name = (isHost ? '👑' : '') + (p.nickname || '') + (offline ? ' (离)' : '');
    ctx.fillText(name.slice(0, 8), S / 2, 110);

    // cards + seal
    const warn = p.cards.length <= 4 && p.cards.length > 0;
    ctx.font = '700 30px "Noto Serif SC", serif';
    ctx.fillStyle = warn ? '#ff5757' : '#fff';
    ctx.fillText('🎴 ' + p.cards.length, S / 2, 152);
    ctx.font = '600 24px "Noto Serif SC", serif';
    ctx.fillStyle = '#ffd700';
    ctx.fillText('印 ' + p.seal, S / 2, 188);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

function layoutOpponents(state, me) {
    const present = new Set();
    Object.values(state.players).forEach(p => {
        if (p.slot === me.slot) return; // don't draw myself as an avatar
        present.add(p.slot);
        const relPos = (p.slot - me.slot + 6) % 6;
        const ang = seatAngle(relPos);
        const cx = Math.cos(ang) * SEAT_RADIUS;
        const cz = Math.sin(ang) * SEAT_RADIUS;

        let o = opponents.get(p.slot);
        if (!o) {
            const group = new THREE.Group();
            scene.add(group);
            const avatar = new THREE.Mesh(
                new THREE.PlaneGeometry(2.0, 2.0),
                new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
            );
            group.add(avatar);
            o = { group, avatar, backs: [] };
            opponents.set(p.slot, o);
        }
        // avatar billboard
        o.avatar.position.set(cx, 2.0, cz);
        o.avatar.lookAt(camera.position);
        const uuid = state.slots[p.slot];
        const isHost = state.hostUuid === uuid;
        const isActive = (state.currentPlayerIndex + 1 === p.slot) && state.status === 'PLAYING';
        if (o.avatar.material.map) o.avatar.material.map.dispose();
        o.avatar.material.map = makeAvatarTexture(p, isHost, isActive);
        o.avatar.material.needsUpdate = true;

        // back-card fan toward the centre
        const want = p.cards.length;
        while (o.backs.length < want) { const b = buildBackMesh(); scene.add(b); o.backs.push(b); }
        while (o.backs.length > want) { const b = o.backs.pop(); scene.remove(b); }
        const inward = Math.atan2(-cz, -cx); // face toward centre
        const fx = Math.cos(ang) * (SEAT_RADIUS - 2.0);
        const fz = Math.sin(ang) * (SEAT_RADIUS - 2.0);
        o.backs.forEach((b, i) => {
            const off = i - (want - 1) / 2;
            const px = fx + Math.cos(inward + Math.PI / 2) * off * 0.34;
            const pz = fz + Math.sin(inward + Math.PI / 2) * off * 0.34;
            b.position.set(px, 0.12 + i * 0.01, pz);
            // lay flat, back up, oriented along the seat
            b.rotation.set(Math.PI / 2, 0, -inward);
        });
    });

    // remove opponents that left
    [...opponents.keys()].forEach(slot => {
        if (!present.has(slot)) {
            const o = opponents.get(slot);
            o.backs.forEach(b => scene.remove(b));
            scene.remove(o.group);
            opponents.delete(slot);
        }
    });
}

function clearSceneForLobby() {
    [...handMeshes.keys()].forEach(id => { handScene.remove(handMeshes.get(id)); handMeshes.delete(id); });
    [...tableMeshes.keys()].forEach(id => { scene.remove(tableMeshes.get(id)); tableMeshes.delete(id); });
    [...opponents.keys()].forEach(slot => {
        const o = opponents.get(slot);
        o.backs.forEach(b => scene.remove(b));
        scene.remove(o.group);
        opponents.delete(slot);
    });
    handOrder = [];
}

/* ===================================================================
   ANIMATION LOOP
   =================================================================== */
function animate() {
    requestAnimationFrame(animate);
    // table / opponent cards tween via quaternion
    tableMeshes.forEach(m => {
        if (m.userData.tPos) m.position.lerp(m.userData.tPos, 0.2);
        if (m.userData.tQuat) m.quaternion.slerp(m.userData.tQuat, 0.2);
        if (m.userData.tScale !== undefined) m.scale.setScalar(THREE.MathUtils.lerp(m.scale.x, m.userData.tScale, 0.22));
    });
    // HUD hand cards tween via simple z-rotation
    handMeshes.forEach(m => {
        if (m.userData.tPos) m.position.lerp(m.userData.tPos, 0.25);
        if (m.userData.tRot !== undefined) m.rotation.z = THREE.MathUtils.lerp(m.rotation.z, m.userData.tRot, 0.25);
        if (m.userData.tScale !== undefined) m.scale.setScalar(THREE.MathUtils.lerp(m.scale.x, m.userData.tScale, 0.25));
    });
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(handScene, handCamera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    placeCamera();
    sizeHud();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (lastState && lastState.players[myUUID] && lastState.status !== 'LOBBY') {
        layoutHand(lastState.players[myUUID].cards, lastState.status);
    }
});

/* ===================================================================
   POINTER: select (click) + reorder (drag) on my hand
   =================================================================== */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down = null;      // { id, x, y }
let dragging = false;

function setPointer(e) {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}
function pickHand() {
    raycaster.setFromCamera(pointer, handCamera);
    const hits = raycaster.intersectObjects([...handMeshes.values()], true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !o.userData.card) o = o.parent;   // glow child -> card
    return o;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!lastState) return;
    const me = lastState.players[myUUID];
    if (!me || (lastState.status !== 'PLAYING' && lastState.status !== 'EXCHANGING')) return;
    setPointer(e);
    const hit = pickHand();
    if (hit) down = { id: hit.userData.card.id, x: e.clientX, y: e.clientY };
    dragging = false;
});

renderer.domElement.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 14) dragging = true;
    if (!dragging) return;
    setPointer(e);
    // map pointer x (NDC) -> HUD world x -> target index
    const n = handOrder.length;
    const spacing = handSpacing(n) || 1;
    const worldX = pointer.x * (HUD.W / 2);
    let idx = Math.round(worldX / spacing + (n - 1) / 2);
    idx = Math.max(0, Math.min(n - 1, idx));
    const cur = handOrder.indexOf(down.id);
    if (cur !== -1 && cur !== idx) {
        handOrder.splice(cur, 1);
        handOrder.splice(idx, 0, down.id);
        layoutHand(lastState.players[myUUID].cards, lastState.status);
    }
});

function endDrag() {
    if (!down) return;
    if (dragging) {
        socket.emit('reorder_hand', { uuid: myUUID, newOrderIds: handOrder.slice() });
    } else {
        // click = toggle selection
        toggleSelect(down.id);
    }
    down = null; dragging = false;
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointerleave', endDrag);

function toggleSelect(id) {
    if (!lastState) return;
    playSound('click');
    const status = lastState.status;
    const has = selectedIds.includes(id);
    if (status === 'EXCHANGING') {
        selectedIds = has ? [] : [id];
    } else {
        if (has) selectedIds = selectedIds.filter(x => x !== id);
        else selectedIds.push(id);
    }
    layoutHand(lastState.players[myUUID].cards, status);
}

/* ===================================================================
   HINT (提示): find legal plays, mirroring server rules exactly
   =================================================================== */
let hintList = null;   // recomputed lazily, invalidated on every sync
let hintIdx = 0;

/* identical to server's calculatePower: digits concatenated, 10 sorted first */
function serverPower(cards) {
    if (!cards || cards.length === 0) return 0;
    const vals = cards.map(c => c.value).sort((a, b) => {
        if (a === 10) return -1;
        if (b === 10) return 1;
        return b - a;
    });
    return parseInt(vals.join(''));
}
function isValidComboLocal(cards) {
    if (cards.length === 0) return false;
    return cards.every(c => c.attr === cards[0].attr) || cards.every(c => c.value === cards[0].value);
}

/* every same-attr / same-value subset of the hand (deduped) */
function allCombos(cards) {
    const byAttr = {}, byVal = {};
    cards.forEach(c => {
        (byAttr[c.attr] = byAttr[c.attr] || []).push(c);
        (byVal[c.value] = byVal[c.value] || []).push(c);
    });
    const seen = new Set();
    const out = [];
    const addGroup = (group) => {
        const n = group.length;                       // hand ≤ 11, so masks are cheap
        for (let mask = 1; mask < (1 << n); mask++) {
            const combo = [];
            for (let i = 0; i < n; i++) if (mask & (1 << i)) combo.push(group[i]);
            const key = combo.map(c => c.id).sort().join(',');
            if (!seen.has(key)) { seen.add(key); out.push(combo); }
        }
    };
    Object.values(byAttr).forEach(addGroup);
    Object.values(byVal).forEach(addGroup);
    return out;
}

function computeHints(state, me) {
    const cards = me.cards;
    if (state.tableCards.length === 0) {
        // leading: singles (weakest first); first turn of the game allows ONLY 1 card
        const hints = cards.map(c => [c]).sort((a, b) => serverPower(a) - serverPower(b));
        // otherwise "1 card or all-out" — offer all-out if the whole hand is one combo
        if (!state.isFirstTurn && cards.length > 1 && isValidComboLocal(cards)) hints.push(cards.slice());
        return hints;
    }
    // following: any combo whose power beats the table
    const beats = allCombos(cards).filter(cb => serverPower(cb) > state.lastValidPower);
    beats.sort((a, b) => a.length - b.length || serverPower(a) - serverPower(b));
    return beats.slice(0, 40);   // cheapest plays first; cap the cycle list
}

window.doHint = function () {
    if (!lastState) return;
    const me = lastState.players[myUUID];
    if (!me || lastState.status !== 'PLAYING' || (lastState.currentPlayerIndex + 1) !== me.slot) return;
    if (!hintList) { hintList = computeHints(lastState, me); hintIdx = 0; }
    if (hintList.length === 0) {
        selectedIds = [];
        layoutHand(me.cards, lastState.status);
        return showToast('没有牌能压制，建议跳过');
    }
    playSound('click');
    const combo = hintList[hintIdx % hintList.length];
    hintIdx++;
    selectedIds = combo.map(c => c.id);
    layoutHand(me.cards, lastState.status);
};

/* ===================================================================
   HTML OVERLAY (lobby / controls / modals / toasts)
   =================================================================== */
function showToast(msg) {
    if (msg.includes('试炼终结')) {
        document.getElementById('result-content').innerText = msg;
        document.getElementById('game-over-modal').style.display = 'flex';
        return;
    }
    const c = document.getElementById('toast-container');
    const d = document.createElement('div');
    d.className = 'toast-msg'; d.innerText = msg;
    c.appendChild(d);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 3000);
}

function renderLobby(state) {
    document.getElementById('lobby').style.display = 'flex';
    document.getElementById('controls').style.display = 'none';
    document.getElementById('status-bar').style.display = 'none';
    document.getElementById('picked-info').innerHTML = '';
    const area = document.getElementById('slots-area');
    area.innerHTML = '';
    for (let i = 1; i <= 6; i++) {
        const u = state.slots[i];
        const color = (i == 1 || i == 4) ? '#e74c3c' : (i == 2 || i == 5) ? '#3498db' : '#2ecc71';
        const isHost = u && state.hostUuid === u;
        const crown = isHost ? '<span style="color:gold">👑</span>' : '';
        const div = document.createElement('div');
        div.className = 'slot-item';
        div.style.borderColor = color;
        div.style.boxShadow = `inset 0 0 22px ${color}22`;
        if (!u) div.onclick = () => window.join(i);
        div.innerHTML = `
            <h3 style="margin:0 0 6px 0; color:${color}; font-size:22px; text-shadow:0 0 6px ${color}88;">${i}</h3>
            <div style="font-size:13px; color:${u ? '#aaa' : '#fff'}; font-weight:${u ? 'normal' : 'bold'};">
                ${u ? (u == myUUID ? crown + '[ 我 ]' : crown + '已占领') : '点击入座'}
            </div>`;
        area.appendChild(div);
    }
}

function renderRoundOver(state) {
    const modal = document.getElementById('round-over-modal');
    modal.style.display = 'flex';
    const tbody = document.getElementById('score-body');
    tbody.innerHTML = '';
    const results = state.lastRoundResults.slice().sort((a, b) => a.slot - b.slot);
    results.forEach(r => {
        const tr = document.createElement('tr');
        if (r.added === 0) tr.className = 'score-row-winner';
        const col = (r.slot == 1 || r.slot == 4) ? '#e74c3c' : (r.slot == 2 || r.slot == 5) ? '#3498db' : '#2ecc71';
        tr.innerHTML = `<td>${r.slot}</td><td style="color:${col}">${r.nickname}</td><td>+${r.added}</td><td>${r.total}</td>`;
        tbody.appendChild(tr);
    });
    const btn = document.getElementById('btn-next-round');
    const amIReady = state.readyPlayers.includes(myUUID);
    if (amIReady) {
        btn.disabled = true; btn.innerText = '已就绪'; btn.style.background = '#333'; btn.style.color = '#888';
    } else {
        btn.disabled = false; btn.innerText = '开始下一局'; btn.style.background = ''; btn.style.color = '';
    }
    document.getElementById('ready-status').innerText = `等待: ${state.readyPlayers.length} / 6`;
}

function renderControls(state, me) {
    const ctr = document.getElementById('controls');
    const bPlay = document.getElementById('btn-play');
    const bPass = document.getElementById('btn-pass');
    const bEx = document.getElementById('btn-ex');
    const bHint = document.getElementById('btn-hint');
    bPlay.style.display = bPass.style.display = bEx.style.display = bHint.style.display = 'none';
    ctr.style.display = 'flex';

    if (state.status === 'EXCHANGING') {
        bEx.style.display = 'inline-block';
        if (me.exchanged) { bEx.disabled = true; bEx.innerText = '已送出'; }
        else { bEx.disabled = false; bEx.innerText = '给队友'; }
        return;
    }
    if (state.status === 'PLAYING') {
        const isMyTurn = (state.currentPlayerIndex + 1) === me.slot;
        if (isMyTurn) {
            const lead = state.tableCards.length === 0;
            bHint.style.display = 'inline-block';
            bPlay.style.display = 'inline-block';
            bPlay.innerText = lead ? '领出' : '压制';
            if (!lead) bPass.style.display = 'inline-block';
        }
    }
}

function renderStatusBar(state) {
    const bar = document.getElementById('status-bar');
    bar.style.display = 'block';
    const turn = Object.values(state.players).find(p => p.slot === state.currentPlayerIndex + 1);
    if (state.status === 'PICKING') bar.innerText = '⏳ 等待收录…';
    else if (state.status === 'EXCHANGING') bar.innerText = '🔄 请赠予队友一张牌';
    else bar.innerText = `当前出牌：${turn ? turn.nickname : '—'}`;

    const pickDiv = document.getElementById('picked-info');
    if (state.lastPickedAction) {
        const { nickname, card } = state.lastPickedAction;
        pickDiv.innerHTML = `<div class="mini-card ${card.attr}">${card.attr}${card.value}</div><div class="picked-label">${nickname} 收回</div>`;
    } else {
        pickDiv.innerHTML = '';
    }
}

/* ===================================================================
   SOCKET WIRING
   =================================================================== */
socket.on('connect', () => socket.emit('register_connection', myUUID));
socket.on('msg', m => showToast(m));
socket.on('trigger_audio', ({ sound }) => playSound(sound));

socket.on('sync', (state) => {
    if (lastState) {
        const wasMine = lastState.slots[lastState.currentPlayerIndex + 1] === myUUID;
        const isMine = state.slots[state.currentPlayerIndex + 1] === myUUID;
        if (!wasMine && isMine && state.status === 'PLAYING') playSound('turn');
    }
    lastState = state;
    hintList = null;          // state changed -> recompute hints on next 提示
    const me = state.players[myUUID];

    if (state.status !== 'PICKING') document.getElementById('pick-modal').style.display = 'none';
    if (state.status !== 'ROUND_OVER') document.getElementById('round-over-modal').style.display = 'none';

    if (state.status === 'LOBBY' || !me) {
        clearSceneForLobby();
        renderLobby(state);
        return;
    }
    document.getElementById('lobby').style.display = 'none';

    if (state.status === 'ROUND_OVER') {
        document.getElementById('controls').style.display = 'none';
        renderRoundOver(state);
        return;
    }

    // prune selection to cards we still hold
    const myIds = me.cards.map(c => c.id);
    selectedIds = selectedIds.filter(id => myIds.includes(id));

    renderControls(state, me);
    renderStatusBar(state);
    layoutOpponents(state, me);
    layoutTable(state.tableCards);
    layoutHand(me.cards, state.status);
});

socket.on('pick_required', (cards) => {
    const modal = document.getElementById('pick-modal');
    const list = document.getElementById('pick-options');
    modal.style.display = 'flex';
    list.innerHTML = '';
    cards.forEach(c => {
        const d = document.createElement('div');
        d.className = `pick-card ${c.attr}`;
        d.innerText = c.attr + c.value;
        d.onclick = () => {
            playSound('click');
            socket.emit('picked_card', { uuid: myUUID, cardId: c.id });
            modal.style.display = 'none';
        };
        list.appendChild(d);
    });
});

/* ===================================================================
   WINDOW HANDLERS (referenced by index.html onclick=)
   =================================================================== */
window.join = function (i) {
    playSound('click');
    const name = prompt('请输入昵称') || `道友${i}`;
    socket.emit('join_slot', { slotIndex: i, uuid: myUUID, nickname: name });
};
window.kickPlayer = function (targetUuid) {
    if (confirm('确定要踢出该玩家吗？')) socket.emit('kick_player', { uuid: myUUID, targetUuid });
};
window.doEx = function () {
    if (!lastState) return;
    const me = lastState.players[myUUID];
    const card = me.cards.find(c => c.id === selectedIds[0]);
    if (!card) return showToast('请先选择一张卡牌');
    playSound('play');
    socket.emit('exchange_card', { uuid: myUUID, card });
    selectedIds = [];
};
window.doPlay = function () {
    if (!lastState) return;
    const me = lastState.players[myUUID];
    const cards = me.cards.filter(c => selectedIds.includes(c.id));
    if (cards.length === 0) return showToast('请先选择卡牌');
    playSound('play');
    socket.emit('play_cards', { uuid: myUUID, selectedCards: cards });
    selectedIds = [];
};
window.doPass = function () {
    socket.emit('pass', { uuid: myUUID });
    selectedIds = [];
};
window.readyForNext = function () {
    playSound('click');
    socket.emit('player_ready', { uuid: myUUID });
};

/* once the web font loads, redraw any cached card/back textures in place so
   glyphs use the nicer serif (existing meshes keep the same texture objects) */
if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
        // drop caches so the next built card/avatar gets crisp font glyphs
        _cardTexCache.clear();
        _backTex = null;
    });
}
