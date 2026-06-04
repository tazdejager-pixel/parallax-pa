// Parallax PA - runtime config
// Public values only. All secrets live server-side in n8n + Supabase.
window.PA_CONFIG = {
  // Supabase (Parallax project) - publishable key is safe in the client; RLS protects data.
  SUPABASE_URL: "https://gvyoenbwsyatrhsexjgz.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1N1HSQbrieKbAwXMA7Vqug_hPv0Z05t",

  // n8n webhook endpoints (Parallax tenant). Filled as each workflow is built.
  // Base is the n8n cloud webhook host; paths are per-workflow.
  N8N_WEBHOOK_BASE: "https://parallax.app.n8n.cloud/webhook",
  ENDPOINTS: {
    sendTask:   "/pa-send-task",   // Slice 1
    transcribe: "/pa-transcribe",  // Slice 1 (voice -> text)
    chat:       "/pa-chat",        // Slice 2
    speak:      "/pa-speak",       // Slice 3 (text -> audio)
    subscribe:  "/pa-subscribe",   // Slice 4 (push registration)
    structure:  "/pa-structure",   // Slice 5 (tidy a rambled note + suggest workspace)
    brief:      "/pa-brief",       // Slice 5 (spoken morning brief)
  },

  // Workspaces a task can be routed to (writes to workspace-registry/inbox/).
  // "auto" = the backend picks the right one from the task text (Slice 5).
  // Note: clients (Wild Eagle, MiSure, ...) are NOT workspaces - client work goes to ParallaxAI.
  WORKSPACES: [
    { id: "auto",      label: "Auto - pick for me" },
    { id: "parallax",  label: "ParallaxAI" },
    { id: "launcht",   label: "Launcht Marketing" },
    { id: "fueltap",   label: "FuelTap" },
    { id: "qrtip",     label: "QR-TIP" },
    { id: "tarryn",    label: "Tarryn" },
    { id: "attorney",  label: "Attorney" },
  ],

  // Web Push public key (VAPID). The private half lives server-side (Supabase edge function pa-push).
  VAPID_PUBLIC_KEY: "BE9cLY92lQbdB18YBS7qDzLDO45iXUiwtkcCV3fgS-yD11k51lBXHL5S6oyW1ts8BNaVkyD4xQhEifbvF93kmuA",
};
