import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import axios from 'axios'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

const httpServer = createServer(app)
const io = new Server(httpServer, { 
    cors: { origin: '*', methods: ["GET", "POST"] } 
})

const API_BASE_URL = process.env.API_BASE_URL || 'http://api:8000'
const API_WEBHOOK_URL = process.env.API_WEBHOOK_URL || `${API_BASE_URL}/webhook/mensagem`
let sockGlobal
let lastQR = null
const lidMap = {}

// ═════════════════════════════════════════
// ROTA QR CODE
// ═════════════════════════════════════════
app.get('/qrcode', async (req, res) => {
    if (!lastQR) {
        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px">
                <h2>QR Code ainda não disponível</h2>
                <p>Aguarde alguns segundos e recarregue a página.</p>
                <script>setTimeout(()=>location.reload(), 3000)</script>
            </body></html>
        `)
    }
    try {
        const qrImageUrl = await QRCode.toDataURL(lastQR)
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0">
                <h2>📱 Escaneie o QR Code no WhatsApp</h2>
                <img src="${qrImageUrl}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:8px"/>
                <p>WhatsApp → Dispositivos Conectados → Conectar dispositivo</p>
                <p style="color:#999;font-size:12px">Esta página atualiza sozinha a cada 5s</p>
                <script>setTimeout(()=>location.reload(), 5000)</script>
            </body></html>
        `)
    } catch (e) {
        res.status(500).send('Erro ao gerar QR: ' + e.message)
    }
})

app.get('/qrcode-raw', (req, res) => {
    if (!lastQR) {
        return res.json({ qr: null, pending: false })
    }
    res.json({ qr: lastQR, pending: true })
})

// ═════════════════════════════════════════
// CONECTAR AO WHATSAPP
// ═════════════════════════════════════════
async function connectToWhatsApp() {
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Versão do WhatsApp Web: v${version.join('.')}`)

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_estoque')
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "122.0.0"],
        generateHighQualityLinkPreview: true,
        syncFullHistory: false
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            lastQR = qr
            console.log('\n👇 QR disponível em: http://localhost:3000/qrcode')
            qrcode.generate(qr, { small: true })
            try {
                const qrImageUrl = await QRCode.toDataURL(qr)
                io.emit('qr_code', { qr: qrImageUrl })
            } catch(e) {}
        }

        if (connection === 'close') {
            lastQR = null
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true
            console.log('Conexão fechada. Tentando reconectar:', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            lastQR = null
            console.log('✅ WHATSAPP CONECTADO - AGUARDANDO MENSAGENS')
            sockGlobal = sock
            io.emit('wpp_conectado', { status: true })

            const numeroConectado = sock.user?.id?.split(':')[0]
            if (numeroConectado) {
                try {
                    await axios.post(`${API_BASE_URL}/admin/conexao/atualizar`, { numero: numeroConectado }, { timeout: 10000 })
                    console.log(`📡 API notificada do número conectado: ${numeroConectado}`)
                } catch (e) {
                    console.error('⚠️ Erro ao notificar API sobre conexão:', e.message)
                }
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.lid && c.id) {
                lidMap[c.lid] = c.id
            }
        }
    })

    sock.ev.on('contacts.update', (updates) => {
        for (const c of updates) {
            if (c.lid && c.id) {
                lidMap[c.lid] = c.id
            }
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        const msg = messages[0]

        const remoteJid = msg.key.remoteJid

        // Ignora grupos
        if (remoteJid.endsWith('@g.us')) return

        const pushName  = msg.pushName || ''
        const fromMe    = msg.key.fromMe || false
        const text      = msg.message?.conversation
                       || msg.message?.extendedTextMessage?.text
                       || null

        if (!fromMe && text) {
            // Resolve @lid se necessário
            let jidResolvido = remoteJid
            if (remoteJid.endsWith('@lid')) {
                if (lidMap[remoteJid]) {
                    jidResolvido = lidMap[remoteJid]
                    console.log(`🔄 LID resolvido (mapa): ${remoteJid} → ${jidResolvido}`)
                } else {
                    try {
                        const resultado = await sock.onWhatsApp(remoteJid)
                        if (resultado && resultado[0]?.jid) {
                            jidResolvido = resultado[0].jid
                            lidMap[remoteJid] = jidResolvido
                            console.log(`🔄 LID resolvido (onWhatsApp): ${remoteJid} → ${jidResolvido}`)
                        }
                    } catch (e) {
                        console.log(`⚠️ Erro ao resolver LID: ${e.message}`)
                    }
                }
            }

            io.emit('nova_mensagem', { remoteJid: jidResolvido, pushName, text, fromMe })

            // Envia para API
            try {
                await axios.post(API_WEBHOOK_URL, {
                    remoteJid: jidResolvido,
                    pushName,
                    text,
                    fromMe
                }, { timeout: 10000 })
                console.log(`📨 Webhook enviado | ${jidResolvido}`)
            } catch (e) {
                console.error('Erro ao chamar webhook:', e.message)
            }
        }
    })
}

// ═════════════════════════════════════════
// WEBSOCKET — comunicação com frontend
// ═════════════════════════════════════════
io.on('connection', (socket) => {
    console.log('Interface web conectada')

    if (lastQR) {
        QRCode.toDataURL(lastQR).then(url => socket.emit('qr_code', { qr: url })).catch(() => {})
    }
    
    socket.on('enviar_resposta', async (data) => {
        if (!sockGlobal || !data.jid) return
        try {
            if (data.text) {
                await sockGlobal.sendMessage(data.jid, { text: data.text })
                io.emit('nova_mensagem', { remoteJid: data.jid, text: data.text, fromMe: true })
            }
        } catch (err) {
            console.error('Erro ao responder:', err)
        }
    })
})

// ═════════════════════════════════════════
// ROTAS HTTP
// ═════════════════════════════════════════
app.get('/status', (req, res) => {
    if (sockGlobal && sockGlobal.user) {
        res.json({ 
            connected: true, 
            number: sockGlobal.user.id.split(':')[0]
        })
    } else {
        res.json({ 
            connected: false, 
            number: "", 
            qrPending: !!lastQR 
        })
    }
})

app.post('/resetar', async (req, res) => {
    try {
        const fs = await import('fs')
        if (sockGlobal) {
            try { await sockGlobal.logout() } catch (e) { /* já pode estar desconectado */ }
        }
        sockGlobal = undefined
        lastQR = null
        fs.rmSync('auth_info_estoque', { recursive: true, force: true })
        console.log('🔄 Sessão resetada. Reconectando para gerar novo QR...')
        connectToWhatsApp().catch(err => console.error('Erro ao reconectar após reset:', err))
        res.status(200).json({ status: "success", mensagem: "Sessão resetada. Acesse /qrcode para escanear." })
    } catch (error) {
        console.error("Erro ao resetar sessão:", error)
        res.status(500).json({ error: error.message })
    }
})

app.post('/disparar', async (req, res) => {
    try {
        const { number, message } = req.body
        if (!sockGlobal) return res.status(503).json({ error: "WhatsApp não conectado." })
        if (!number || !message) return res.status(400).json({ error: "Número e mensagem obrigatórios." })

        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`
        await sockGlobal.sendPresenceUpdate('composing', jid)
        await new Promise(r => setTimeout(r, 1500))
        await sockGlobal.sendMessage(jid, { text: message })
        io.emit('nova_mensagem', { remoteJid: jid, text: message, fromMe: true })
        console.log(`🚀 Mensagem enviada para: ${number}`)
        res.status(200).json({ status: "success" })
    } catch (error) {
        console.error("Erro ao disparar:", error)
        res.status(500).json({ error: error.message })
    }
})

app.get('/', (req, res) => {
    res.json({ status: "ok", servico: "Estoque WPP - Baileys" })
})

// ═════════════════════════════════════════
// START
// ═════════════════════════════════════════
httpServer.listen(3000, () => {
    console.log('🚀 SERVIDOR BAILEYS RODANDO NA PORTA 3000')
    connectToWhatsApp().catch(err => {
        console.error('Erro ao conectar ao WhatsApp:', err)
        process.exit(1)
    })
})
