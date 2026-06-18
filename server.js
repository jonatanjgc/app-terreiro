const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Garante que a pasta 'uploads' exista
const uploadDir = process.env.RENDER ? '/data/uploads' : path.join(__dirname, 'uploads');
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

// CAMINHO DO BANCO DE DADOS CORRIGIDO PARA O DISCO PERMANENTE DO RENDER
const dbPath = process.env.RENDER ? '/data/banco-terreiro.sqlite' : path.join(__dirname, 'banco-terreiro.sqlite');
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

const vapidFile = path.join(__dirname, 'chave-vapid.json');
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

function enviarNotificacaoParaTodos(titulo, mensagem) { 
    const payload = JSON.stringify({ titulo, message: mensagem }); 
    db.all(`SELECT * FROM inscricoes_push`, [], (err, inscricoes) => { 
        if (err) return; if(!inscricoes) return;
        inscricoes.forEach((i) => {
            const pushSubscription = { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } };
            webpush.sendNotification(pushSubscription, payload).catch(e => { 
                if(e.statusCode === 410 || e.statusCode === 403 || e.statusCode === 404) {
                    db.run(`DELETE FROM inscricoes_push WHERE endpoint = ?`, [i.endpoint]); 
                }
            });
        });
    }); 
}

app.get('/api/vapid-public-key', (req, res) => { res.json({ publicKey: vapidKeys.publicKey }); });

app.get('/api/escala-limpeza', (req, res) => {
    db.all(`SELECT * FROM escala_limpeza ORDER BY id ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ sucesso: false, erro: err.message });
        res.json({ sucesso: true, escala: rows || [] });
    });
});

app.post('/api/escala-limpeza', (req, res) => {
    const { data_escala, dia_semana, medium_nome, tarefa } = req.body;
    db.run(`INSERT INTO escala_limpeza (data_escala, dia_semana, medium_nome, tarefa) VALUES (?, ?, ?, ?)`,
        [data_escala, dia_semana, medium_nome, tarefa || 'Limpeza Geral'],
        function(err) {
            if (err) return res.status(500).json({ sucesso: false, erro: err.message });
            res.json({ sucesso: true });
        }
    );
});

app.delete('/api/escala-limpeza/:id', (req, res) => {
    db.run(`DELETE FROM escala_limpeza WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ sucesso: false, erro: err.message });
        res.json({ sucesso: true });
    });
});

app.get('/api/biblioteca', (req, res) => { db.all(`SELECT * FROM biblioteca ORDER BY id DESC`, [], (err, rows) => { if (err) { return res.status(500).json({ sucesso: false, erro: err.message }); } res.json({ sucesso: true, livros: rows || [] }); }); });
app.post('/api/biblioteca', upload.single('pdf'), (req, res) => { if (!req.file) { return res.status(400).json({ sucesso: false, mensagem: "Arquivo ausente." }); } db.run(`INSERT INTO biblioteca (titulo, arquivo, categoria) VALUES (?, ?, ?)`, [req.body.titulo, req.file.filename, req.body.categoria], function(err) { if (err) { return res.status(500).json({ sucesso: false, erro: err.message }); } res.json({ sucesso: true }); }); });
app.delete('/api/biblioteca/:id', (req, res) => { db.get(`SELECT arquivo FROM biblioteca WHERE id = ?`, [req.params.id], (err, row) => { if(row) { fs.unlink(path.join(uploadDir, row.arquivo), () => {}); db.run(`DELETE FROM biblioteca WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); } else { res.status(404).json({ sucesso: false }); } }); });
app.get('/api/galeria', (req, res) => { db.all(`SELECT * FROM galeria ORDER BY data_gira DESC, id DESC`, [], (err, rows) => { if (err) return res.status(500).json({ sucesso: false }); res.json({ sucesso: true, registros: rows || [] }); }); });
app.post('/api/galeria', upload.array('fotos', 30), (req, res) => { if (!req.files || req.files.length === 0) return res.status(400).json({ sucesso: false }); let ins = 0; req.files.forEach(f => { db.run(`INSERT INTO galeria (data_gira, linha, arquivo, autor_nome, autor_id) VALUES (?, ?, ?, ?, ?)`, [req.body.data_gira, req.body.linha, f.filename, req.body.autor_nome, req.body.autor_id], function(err) { ins++; if (ins === req.files.length) res.json({ sucesso: true }); }); }); });
app.delete('/api/galeria/:id', (req, res) => { db.get(`SELECT arquivo FROM galeria WHERE id = ?`, [req.params.id], (err, row) => { if(row) { fs.unlink(path.join(uploadDir, row.arquivo), () => {}); db.run(`DELETE FROM galeria WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); } else { res.status(404).json({ sucesso: false }); } }); });
app.post('/api/conteudos', upload.single('imagem'), (req, res) => { const { chave, titulo, texto } = req.body; let imagem = req.file ? req.file.filename : null; db.get(`SELECT chave, imagem FROM conteudos WHERE chave = ?`, [chave], (err, row) => { if (row) { if (!imagem) imagem = row.imagem; else if (row.imagem) { fs.unlink(path.join(uploadDir, row.imagem), () => {}); } db.run(`UPDATE conteudos SET titulo = ?, texto = ?, imagem = ? WHERE chave = ?`, [titulo, texto, imagem, chave], function(err) { if (err) return res.status(500).json({ sucesso: false, erro: err.message }); res.json({ sucesso: true }); }); } else { db.run(`INSERT INTO conteudos (chave, titulo, texto, imagem) VALUES (?, ?, ?, ?)`, [chave, titulo, texto, imagem], function(err) { if (err) return res.status(500).json({ sucesso: false, erro: err.message }); res.json({ sucesso: true }); }); } }); });
app.post('/api/login', (req, res) => { db.get(`SELECT * FROM usuarios WHERE cpf = ? AND senha = ?`, [req.body.cpf, req.body.senha], (erro, u) => { if (erro || !u) return res.status(401).json({ sucesso: false, message: "CPF ou senha incorretos" }); let idVerificar = u.titular_id ? u.titular_id : u.id; db.get(`SELECT * FROM usuarios WHERE id = ?`, [idVerificar], (err, titular) => { if (!titular) titular = u; const statusFinal = processarBloqueioAutomatico(titular); res.json({ sucesso: true, id: u.id, nome: u.nome, perfil: u.perfil, status_mensalidade: statusFinal }); }); }); });
app.get('/api/mediuns', (req, res) => { db.all(`SELECT * FROM configuracoes`, [], (err, confs) => { let precos = { individual: 25, casal: 35, familia3: 45, familia4: 55 }; if (confs) confs.forEach(c => precos[c.plano] = c.valor); db.all(`SELECT * FROM usuarios`, [], (err, usuarios) => { if (err) return res.status(500).json({ sucesso: false }); if (!usuarios) return res.json({ sucesso: true, lista: [], precos }); let titulares = usuarios.filter(u => u.titular_id === null); let dependentes = usuarios.filter(u => u.titular_id !== null); let listaMapeada = titulares.map(t => { const statusOriginal = processarBloqueioAutomatico(t); let meusDependentes = dependentes.filter(d => d.titular_id === t.id); let tamanhoFamilia = 1 + meusDependentes.length; let planoNome = 'Plano Individual', valorPlano = precos.individual; if (tamanhoFamilia === 2) { planoNome = 'Plano Casal'; valorPlano = precos.casal; } else if (tamanhoFamilia === 3) { planoNome = 'Plano Família (3)'; valorPlano = precos.familia3; } else if (tamanhoFamilia >= 4) { planoNome = 'Plano Família (4+)'; valorPlano = precos.familia4; } return { ...t, status_mensalidade: statusOriginal, dependentes: meusDependentes, planoNome, valorPlano }; }); res.json({ sucesso: true, lista: listaMapeada, precos: precos }); }); }); });
app.post('/api/atualizar-status', (req, res) => { const status = req.body.novoStatus; if (status === 'em dia') { const mesAtual = new Date().getMonth() + 1; db.run(`UPDATE usuarios SET status_mensalidade = 'em dia', ultimo_mes_pago = ?, comprovante = NULL WHERE id = ?`, [mesAtual, req.body.id], () => res.json({ sucesso: true })); } else { db.run(`UPDATE usuarios SET status_mensalidade = ? WHERE id = ?`, [status, req.body.id], () => res.json({ sucesso: true })); } });
app.post('/api/cadastrar', (req, res) => { const { nome, cpf, senha, perfil, tipo_vinculo, cpf_titular, vencimento_regra } = req.body; const mesAtual = new Date().getMonth() + 1; if (tipo_vinculo === 'titular') { db.run(`INSERT INTO usuarios (nome, cpf, senha, perfil, vencimento_regra, ultimo_mes_pago) VALUES (?, ?, ?, ?, ?, ?)`, [nome, cpf, senha, perfil, vencimento_regra || '5_dia_util', mesAtual], function(err) { if (err) res.json({ sucesso: false, mensagem: "Erro. CPF já cadastrado." }); else res.json({ sucesso: true, mensagem: "Cadastrado com sucesso!" }); }); } else { db.get(`SELECT id FROM usuarios WHERE cpf = ? AND titular_id IS NULL`, [cpf_titular], (err, titular) => { if (!titular) return res.json({ sucesso: false, mensagem: "CPF do Titular não encontrado." }); db.run(`INSERT INTO usuarios (nome, cpf, senha, perfil, titular_id) VALUES (?, ?, ?, ?, ?)`, [nome, cpf, senha, perfil, titular.id], function(err) { if (err) res.json({ sucesso: false, mensagem: "Erro ao vincular." }); else res.json({ sucesso: true, mensagem: "Dependente cadastrado com sucesso!" }); }); }); } });
app.post('/api/comprovante', upload.single('arquivo'), (req, res) => { if(!req.file) return res.status(400).json({sucesso: false}); db.get(`SELECT titular_id FROM usuarios WHERE id = ?`, [req.body.id], (err, row) => { const idAlvo = (row && row.titular_id) ? row.titular_id : req.body.id; db.run(`UPDATE usuarios SET comprovante = ?, status_mensalidade = 'em analise' WHERE id = ?`, [req.file.filename, idAlvo], () => res.json({sucesso: true})); }); });
app.get('/api/conteudos/:chave', (req, res) => { db.get(`SELECT * FROM conteudos WHERE chave = ?`, [req.params.chave], (err, l) => res.json({ sucesso: true, conteudo: l })); });
app.get('/api/agenda', (req, res) => { db.all(`SELECT * FROM agenda ORDER BY id ASC`, [], (err, l) => res.json({ sucesso: true, agenda: l })); });
app.delete('/api/agenda/:id', (req, res) => { db.run(`DELETE FROM agenda WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); });
app.get('/api/avisos', (req, res) => { db.all(`SELECT * FROM avisos ORDER BY id DESC`, [], (err, l) => { res.json({ sucesso: true, avisos: l || [] }); }); });
app.delete('/api/avisos/:id', (req, res) => { db.run(`DELETE FROM avisos WHERE id = ?`, [req.params.id], () => res.json({ sucesso: true })); });
app.post('/api/atualizar-precos', (req, res) => { const p = req.body; db.serialize(() => { db.run(`UPDATE configuracoes SET valor = ? WHERE plano = 'individual'`, [p.individual]); db.run(`UPDATE configuracoes SET valor = ? WHERE plano = 'casal'`, [p.casal]); db.run(`UPDATE configuracoes SET valor = ? WHERE plano = 'familia3'`, [p.familia3]); db.run(`UPDATE configuracoes SET valor = ? WHERE plano = 'familia4'`, [p.familia4]); }); res.json({ sucesso: true }); });
app.get('/api/buscar-titular/:cpf', (req, res) => { db.get(`SELECT id, nome FROM usuarios WHERE cpf = ? AND titular_id IS NULL`, [req.params.cpf], (err, row) => { if (row) res.json({ sucesso: true, id: row.id, nome: row.nome }); else res.json({ sucesso: false }); }); });
app.post('/api/editar-medium', (req, res) => { const { id, nome, cpf, senha } = req.body; if (senha) { db.run(`UPDATE usuarios SET nome = ?, cpf = ?, senha = ? WHERE id = ?`, [nome, cpf, senha, id], () => res.json({ sucesso: true, mensagem: "Editado com senha!" })); } else { db.run(`UPDATE usuarios SET nome = ?, cpf = ? WHERE id = ?`, [nome, cpf, id], () => res.json({ sucesso: true, mensagem: "Editado com sucesso!" })); } });
app.delete('/api/excluir-medium/:id', (req, res) => { db.run(`DELETE FROM usuarios WHERE id = ? OR titular_id = ?`, [req.params.id, req.params.id], () => res.json({ sucesso: true })); });
app.post('/api/inscrever-push', (req, res) => { db.run(`INSERT OR REPLACE INTO inscricoes_push (endpoint, p256dh, auth) VALUES (?, ?, ?)`, [req.body.endpoint, req.body.keys.p256dh, req.body.keys.auth], () => res.json({ sucesso: true })); });
app.post('/api/avisos', (req, res) => { db.run(`INSERT INTO avisos (titulo, mensagem, tipo) VALUES (?, ?, ?)`, [req.body.titulo, req.body.mensagem, req.body.tipo], (e) => { if(e) { db.run(`INSERT INTO avisos (titulo, message, tipo) VALUES (?, ?, ?)`, [req.body.titulo, req.body.mensagem, req.body.tipo], () => res.json({sucesso:true})); } else { res.json({sucesso:true}); } }); });

cron.schedule('0 9 * * *', () => { 
    const meses = {'Jan':0, 'Fev':1, 'Mar':2, 'Abr':3, 'Mai':4, 'Jun':5, 'Jul':6, 'Ago':7, 'Set':8, 'Out':9, 'Nov':10, 'Dez':11}; 
    const hoje = new Date(); hoje.setHours(0,0,0,0); 
    db.all(`SELECT * FROM agenda`, [], (err, giras) => { 
        if(giras) giras.forEach(gira => { 
            const dataGira = new Date(hoje.getFullYear(), meses[gira.mes], parseInt(gira.dia)); 
            const diff = Math.ceil((dataGira - hoje) / (1000 * 60 * 60 * 24)); 
            if(diff === 3) enviarNotificacaoParaTodos('Programe-se!', `Faltam 3 dias para a Gira de ${gira.titulo}.`); 
            if(diff === 1) enviarNotificacaoParaTodos('É Amanhã!', `A Gira de ${gira.titulo} é amanhã às ${gira.horario}.`); 
            if(diff === 0) enviarNotificacaoParaTodos('É Hoje!', `Hoje tem Gira de ${gira.titulo} às ${gira.horario}. Traga sua fé!`); 
        }); 
    }); 
});

startServer();