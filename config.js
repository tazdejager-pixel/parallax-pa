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
  },

  // Workspaces a task can be routed to (writes to workspace-registry/inbox/).
  WORKSPACES: [
    { id: "parallax",  label: "Parallax" },
    { id: "launcht",   label: "Launcht" },
    { id: "fueltap",   label: "FuelTap" },
    { id: "wildeagle", label: "Wild Eagle" },
    { id: "qrtip",     label: "QR-TIP" },
    { id: "attorney",  label: "Attorney" },
  ],

  // Web Push public key (VAPID). Filled in Slice 4.
  VAPID_PUBLIC_KEY: "",
};
