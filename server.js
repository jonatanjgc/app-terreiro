const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Configuração do Banco de Dados Neon (Postgres)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Configuração de Uploads
if (!fs.existsSync('./uploads')) { fs.mkdirSync('./uploads'); }
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage });
app.use('/uploads', express.static('uploads'));

// --- ROTAS DA API ---

// Login
app.post('/api/login', async (req, res) => {
    const { cpf, senha } = req.body;
    try {
        const result = await pool.query("SELECT * FROM usuarios WHERE cpf = $1 AND senha = $2", [cpf, senha]);
        if (result.rows.length > 0) res.json({ sucesso: true, ...result.rows[0] });
        else res.json({ sucesso: false, mensagem: "Dados inválidos." });
    } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

// Financeiro
app.get('/api/mediuns', async (req, res) => {
    try {
        const configResult = await pool.query("SELECT * FROM configuracoes");
        const usersResult = await pool.query("SELECT * FROM usuarios");
        const precos = {};
        configResult.rows.forEach(r => precos[r.plano] = r.valor);
        res.json({ sucesso: true, lista: usersResult.rows, precos: precos });
    } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

// Doações
app.get('/api/doacoes', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM doacoes ORDER BY id DESC");
        res.json({ sucesso: true, lista: result.rows });
    } catch (e) { res.status(500).json({ sucesso: false, lista: [] }); }
});

app.post('/api/doacoes', async (req, res) => {
    const { nome, valor } = req.body;
    try {
        await pool.query("INSERT INTO doacoes (nome, valor) VALUES ($1, $2)", [nome, valor]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ sucesso: false }); }
});

// Cadastro
app.post('/api/cadastrar', async (req, res) => {
    const { nome, cpf, senha, perfil, cpf_titular, vencimento_regra } = req.body;
    const titularId = (cpf_titular && cpf_titular.trim() !== "") ? cpf_titular : null;
    try {
        await pool.query("INSERT INTO usuarios (nome, cpf, senha, perfil, titular_id, vencimento_regra) VALUES ($1, $2, $3, $4, $5, $6)", 
        [nome, cpf, senha, perfil, titularId, vencimento_regra]);
        res.json({ sucesso: true, mensagem: "Cadastro realizado!" });
    } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

// Avisos
app.get('/api/avisos', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM avisos ORDER BY id DESC");
        res.json({ avisos: result.rows });
    } catch (e) { res.status(500).json({ avisos: [] }); }
});

app.post('/api/avisos', async (req, res) => {
    const { titulo, mensagem, tipo } = req.body;
    try {
        await pool.query("INSERT INTO avisos (titulo, mensagem, tipo) VALUES ($1, $2, $3)", [titulo, mensagem, tipo]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ sucesso: false }); }
});

// Agenda
app.get('/api/agenda', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM agenda");
        res.json({ agenda: result.rows });
    } catch (e) { res.status(500).json({ agenda: [] }); }
});

app.post('/api/agenda', async (req, res) => {
    const { dia, mes, titulo, horario, publico } = req.body;
    await pool.query("INSERT INTO agenda (dia, mes, titulo, horario, publico) VALUES ($1, $2, $3, $4, $5)", [dia, mes, titulo, horario, publico]);
    res.json({ sucesso: true });
});

// Conteúdos
app.get('/api/conteudos/:chave', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM conteudos WHERE chave = $1", [req.params.chave]);
        res.json({ conteudo: result.rows[0] || {} });
    } catch (e) { res.json({ conteudo: {} }); }
});

app.post('/api/conteudos', upload.single('imagem'), async (req, res) => {
    const { chave, titulo, texto } = req.body;
    const imagem = req.file ? req.file.filename : null;
    try {
        if (imagem) await pool.query("INSERT INTO conteudos (chave, titulo, texto, imagem) VALUES ($1, $2, $3, $4) ON CONFLICT (chave) DO UPDATE SET titulo=$2, texto=$3, imagem=$4", [chave, titulo, texto, imagem]);
        else await pool.query("INSERT INTO conteudos (chave, titulo, texto) VALUES ($1, $2, $3) ON CONFLICT (chave) DO UPDATE SET titulo=$2, texto=$3", [chave, titulo, texto]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ sucesso: false }); }
});

// Biblioteca
app.get('/api/biblioteca', async (req, res) => {
    const result = await pool.query("SELECT * FROM biblioteca");
    res.json({ livros: result.rows });
});

app.post('/api/biblioteca', upload.single('pdf'), async (req, res) => {
    const { titulo, categoria } = req.body;
    const arquivo = req.file.filename;
    await pool.query("INSERT INTO biblioteca (titulo, categoria, arquivo) VALUES ($1, $2, $3)", [titulo, categoria, arquivo]);
    res.json({ sucesso: true });
});

// Escala Limpeza
app.get('/api/escala-limpeza', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM escala_limpeza");
        res.json({ escala: result.rows });
    } catch (e) { res.json({ escala: [] }); }
});

app.post('/api/escala-limpeza', async (req, res) => {
    const { data_escala, dia_semana, medium_nome, tarefa } = req.body;
    await pool.query("INSERT INTO escala_limpeza (data_escala, dia_semana, medium_nome, tarefa) VALUES ($1, $2, $3, $4)", [data_escala, dia_semana, medium_nome, tarefa]);
    res.json({ sucesso: true });
});

// Comprovantes
app.post('/api/comprovante', upload.single('arquivo'), async (req, res) => {
    const { id } = req.body;
    const arquivo = req.file.filename;
    await pool.query("UPDATE usuarios SET comprovante = $1, status_mensalidade = 'em analise' WHERE id = $2", [arquivo, id]);
    res.json({ sucesso: true });
});

// Status Financeiro
app.post('/api/atualizar-status', async (req, res) => {
    const { id, novoStatus } = req.body;
    await pool.query("UPDATE usuarios SET status_mensalidade = $1 WHERE id = $2", [novoStatus, id]);
    res.json({ sucesso: true });
});

// Preços
app.post('/api/atualizar-precos', async (req, res) => {
    const { individual, casal, familia3, familia4 } = req.body;
    const planos = [['individual', individual], ['casal', casal], ['familia3', familia3], ['familia4', familia4]];
    for (let p of planos) {
        await pool.query("INSERT INTO configuracoes (plano, valor) VALUES ($1, $2) ON CONFLICT (plano) DO UPDATE SET valor = $2", p);
    }
    res.json({ sucesso: true });
});

// Galeria
app.get('/api/galeria', async (req, res) => {
    const result = await pool.query("SELECT * FROM galeria");
    res.json({ registros: result.rows });
});

app.post('/api/galeria', upload.array('fotos'), async (req, res) => {
    const { data_gira, linha, autor_nome, autor_id } = req.body;
    for (let file of req.files) {
        await pool.query("INSERT INTO galeria (data_gira, linha, arquivo, autor_nome, autor_id) VALUES ($1, $2, $3, $4, $5)", [data_gira, linha, file.filename, autor_nome, autor_id]);
    }
    res.json({ sucesso: true });
});

// Rota Final: Servir o Frontend
app.use(express.static('.'));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
