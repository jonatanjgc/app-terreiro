const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Usamos pastas dentro de __dirname (o diretório do projeto), que sempre têm permissão
const dataDir = path.join(__dirname, 'dados_persistentes');
const uploadDir = path.join(dataDir, 'uploads');

if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir, { recursive: true }); }
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir, { recursive: true }); }

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir); },
    filename: function (req, file, cb) { 
        const nomeLimpo = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1000) + '-' + nomeLimpo);
    }
});
const upload = multer({ storage: storage });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.')); 
app.use('/uploads', express.static(uploadDir));

// Banco de dados em arquivo local na pasta do projeto
const dbPath = path.join(dataDir, 'banco-terreiro.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("❌ Erro ao conectar ao banco:", err.message);
    else console.log("🗄️ Banco de dados conectado em:", dbPath);
});

// FUNÇÃO DE BLOQUEIO
function processarBloqueioAutomatico(usuario) {
    if (!usuario) return 'em dia';
    if (usuario.perfil === 'super_admin' || usuario.perfil === 'sacerdote' || usuario.perfil === 'tesoureiro') return usuario.status_mensalidade; 
    if (usuario.status_mensalidade === 'atrasado' || usuario.status_mensalidade === 'em analise') return usuario.status_mensalidade; 
    const hoje = new Date(); const mesAtual = hoje.getMonth() + 1; 
    const mesPago = usuario.ultimo_mes_pago !== undefined ? usuario.ultimo_mes_pago : 0;
    if (mesPago >= mesAtual) return 'em dia';
    let diaLimite = 20; const regra = usuario.vencimento_regra || '5_dia_util';
    if (regra === '5_dia_util') {
        let count = 0; let d = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        while (count < 5) { let dow = d.getDay(); if (dow !== 0 && dow !== 6) count++; if (count < 5) d.setDate(d.getDate() + 1); }
        diaLimite = d.getDate();
    }
    if (hoje.getDate() > diaLimite) { db.run(`UPDATE usuarios SET status_mensalidade = 'atrasado' WHERE id = ?`, [usuario.id]); return 'atrasado'; }
    return 'em dia';
}

const vapidFile = path.join(dataDir, 'chave-vapid.json');
let vapidKeys;
if (fs.existsSync(vapidFile)) {
    vapidKeys = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
} else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(vapidFile, JSON.stringify(vapidKeys, null, 2), 'utf8');
}
webpush.setVapidDetails('mailto:contato@setecoracoes.com', vapidKeys.publicKey, vapidKeys.privateKey);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS configuracoes (plano TEXT PRIMARY KEY, valor REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, cpf TEXT UNIQUE, senha TEXT, perfil TEXT, status_mensalidade TEXT DEFAULT 'em dia', titular_id INTEGER DEFAULT NULL, comprovante TEXT DEFAULT NULL, vencimento_regra TEXT DEFAULT '5_dia_util', ultimo_mes_pago INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS avisos (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT, mensagem TEXT, tipo TEXT, data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS conteudos (chave TEXT PRIMARY KEY, titulo TEXT, icone TEXT, texto TEXT, imagem TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS agenda (id INTEGER PRIMARY KEY AUTOINCREMENT, dia TEXT, mes TEXT, titulo TEXT, horario TEXT, publico BOOLEAN)`);
    db.run(`CREATE TABLE IF NOT EXISTS inscricoes_push (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS biblioteca (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT, arquivo TEXT, categoria TEXT DEFAULT 'livro')`); 
    db.run(`CREATE TABLE IF NOT EXISTS galeria (id INTEGER PRIMARY KEY AUTOINCREMENT, data_gira TEXT, linha TEXT, arquivo TEXT, autor_nome TEXT, autor_id INTEGER)`); 
    db.run(`CREATE TABLE IF NOT EXISTS escala_limpeza (id INTEGER PRIMARY KEY AUTOINCREMENT, data_escala TEXT, dia_semana TEXT, medium_nome TEXT, tarefa TEXT)`);
    db.run(`INSERT OR IGNORE INTO configuracoes (plano, valor) VALUES ('individual', 25.00), ('casal', 35.00), ('familia3', 45.00), ('familia4', 55.00)`);
    db.run(`INSERT OR IGNORE INTO usuarios (nome, cpf, senha, perfil, status_mensalidade, ultimo_mes_pago) VALUES ('Jonatan', '00000000000', '123456', 'super_admin', 'em dia', 12)`);
});

function startServer() {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}!`));
}

// Rotas da API
app.get('/api/vapid-public-key', (req, res) => { res.json({ publicKey: vapidKeys.publicKey }); });
app.get('/api/escala-limpeza', (req, res) => { db.all(`SELECT * FROM escala_limpeza ORDER BY id ASC`, [], (err, rows) => { res.json({ sucesso: true, escala: rows || [] }); }); });
app.post('/api/escala-limpeza', (req, res) => { const { data_escala, dia_semana, medium_nome, tarefa } = req.body; db.run(`INSERT INTO escala_limpeza (data_escala, dia_semana, medium_nome, tarefa) VALUES (?, ?, ?, ?)`, [data_escala, dia_semana, medium_nome, tarefa || 'Limpeza Geral'], () => res.json({ sucesso: true })); });
app.delete('/api/escala-limpeza/:id', (req, res) => { db.run(`DELETE FROM escala_limpeza WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); });
app.get('/api/biblioteca', (req, res) => { db.all(`SELECT * FROM biblioteca ORDER BY id DESC`, [], (err, rows) => { res.json({ sucesso: true, livros: rows || [] }); }); });
app.post('/api/biblioteca', upload.single('pdf'), (req, res) => { if (!req.file) return res.status(400).json({ sucesso: false }); db.run(`INSERT INTO biblioteca (titulo, arquivo, categoria) VALUES (?, ?, ?)`, [req.body.titulo, req.file.filename, req.body.categoria], () => res.json({ sucesso: true })); });
app.delete('/api/biblioteca/:id', (req, res) => { db.get(`SELECT arquivo FROM biblioteca WHERE id = ?`, [req.params.id], (err, row) => { if(row) { fs.unlink(path.join(uploadDir, row.arquivo), () => {}); db.run(`DELETE FROM biblioteca WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); } }); });
app.get('/api/galeria', (req, res) => { db.all(`SELECT * FROM galeria ORDER BY data_gira DESC, id DESC`, [], (err, rows) => { res.json({ sucesso: true, registros: rows || [] }); }); });
app.post('/api/galeria', upload.array('fotos', 30), (req, res) => { if (!req.files) return res.status(400).json({ sucesso: false }); req.files.forEach(f => db.run(`INSERT INTO galeria (data_gira, linha, arquivo, autor_nome, autor_id) VALUES (?, ?, ?, ?, ?)`, [req.body.data_gira, req.body.linha, f.filename, req.body.autor_nome, req.body.autor_id])); res.json({ sucesso: true }); });
app.delete('/api/galeria/:id', (req, res) => { db.get(`SELECT arquivo FROM galeria WHERE id = ?`, [req.params.id], (err, row) => { if(row) { fs.unlink(path.join(uploadDir, row.arquivo), () => {}); db.run(`DELETE FROM galeria WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); } }); });
app.post('/api/conteudos', upload.single('imagem'), (req, res) => { const { chave, titulo, texto } = req.body; let imagem = req.file ? req.file.filename : null; db.get(`SELECT chave, imagem FROM conteudos WHERE chave = ?`, [chave], (err, row) => { if (row) { if (row.imagem) fs.unlink(path.join(uploadDir, row.imagem), () => {}); db.run(`UPDATE conteudos SET titulo = ?, texto = ?, imagem = ? WHERE chave = ?`, [titulo, texto, imagem || row.imagem, chave], () => res.json({ sucesso: true })); } else { db.run(`INSERT INTO conteudos (chave, titulo, texto, imagem) VALUES (?, ?, ?, ?)`, [chave, titulo, texto, imagem], () => res.json({ sucesso: true })); } }); });
app.post('/api/login', (req, res) => { db.get(`SELECT * FROM usuarios WHERE cpf = ? AND senha = ?`, [req.body.cpf, req.body.senha], (erro, u) => { if (!u) return res.status(401).json({ sucesso: false }); let idVerificar = u.titular_id || u.id; db.get(`SELECT * FROM usuarios WHERE id = ?`, [idVerificar], (err, titular) => { const statusFinal = processarBloqueioAutomatico(titular || u); res.json({ sucesso: true, id: u.id, nome: u.nome, perfil: u.perfil, status_mensalidade: statusFinal }); }); }); });
app.get('/api/mediuns', (req, res) => { db.all(`SELECT * FROM usuarios`, [], (err, u) => res.json({ sucesso: true, lista: u })); });
app.post('/api/cadastrar', (req, res) => { const { nome, cpf, senha, perfil, tipo_vinculo, cpf_titular } = req.body; if (tipo_vinculo === 'titular') db.run(`INSERT INTO usuarios (nome, cpf, senha, perfil) VALUES (?, ?, ?, ?)`, [nome, cpf, senha, perfil], () => res.json({ sucesso: true })); else db.get(`SELECT id FROM usuarios WHERE cpf = ?`, [cpf_titular], (err, t) => { db.run(`INSERT INTO usuarios (nome, cpf, senha, perfil, titular_id) VALUES (?, ?, ?, ?, ?)`, [nome, cpf, senha, perfil, t.id], () => res.json({ sucesso: true })); }); });
app.post('/api/comprovante', upload.single('arquivo'), (req, res) => { db.run(`UPDATE usuarios SET comprovante = ?, status_mensalidade = 'em analise' WHERE id = ?`, [req.file.filename, req.body.id], () => res.json({ sucesso: true })); });
app.get('/api/agenda', (req, res) => { db.all(`SELECT * FROM agenda ORDER BY id ASC`, [], (err, l) => res.json({ sucesso: true, agenda: l })); });
app.post('/api/agenda', (req, res) => { db.run(`INSERT INTO agenda (dia, mes, titulo, horario, publico) VALUES (?, ?, ?, ?, ?)`, [req.body.dia, req.body.mes, req.body.titulo, req.body.horario, req.body.publico], () => res.json({ sucesso: true })); });
app.delete('/api/agenda/:id', (req, res) => { db.run(`DELETE FROM agenda WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); });

startServer();