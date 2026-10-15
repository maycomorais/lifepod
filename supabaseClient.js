// supabaseClient.js
// ─────────────────────────────────────────────────────────────
// Preencha com os dados do seu projeto no Supabase:
//   supabase.com → Settings → API
// ─────────────────────────────────────────────────────────────

const _SUPABASE_URL = 'https://dszdrkndlfxcyokcduwz.supabase.co';
const _SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzemRya25kbGZ4Y3lva2NkdXd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwOTQzNzksImV4cCI6MjEwNzY3MDM3OX0.AEI76ZT0rQwYLQp4E1h38riJaa5mr0wYRTq1FBh76uQ';

if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    console.error('ERRO CRÍTICO: Biblioteca Supabase não carregou. Verifique sua conexão.');
    // Não usa alert() — apenas loga. O checkUser() vai redirecionar para login se supa for null.
} else {
    window.supa = window.supabase.createClient(_SUPABASE_URL, _SUPABASE_KEY);
    console.log('Banco iniciado.');
}

async function checkUser() {
    try {
        if (!window.supa) {
            console.error('checkUser: cliente Supabase não inicializado.');
            window.location.href = 'login.html';
            return null;
        }
        const { data: { session } } = await window.supa.auth.getSession();
        if (!session) {
            window.location.href = 'login.html';
            return null;
        }
        return session;
    } catch(e) {
        console.error('checkUser error:', e);
        window.location.href = 'login.html';
        return null;
    }
}