/* Parallax PA - app logic (vanilla, no build step) */
(function () {
  "use strict";
  const C = window.PA_CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const webhook = (key) => C.N8N_WEBHOOK_BASE + C.ENDPOINTS[key];

  let listenDefault = false;

  /* ---------- Auth (single user - Tarryn) ---------- */
  let session = null;
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    if (session) h["Authorization"] = "Bearer " + session.access_token;
    return h;
  }
  function updateAuthUI() {
    $("loginScreen").hidden = !!session;
    $("signedInAs").textContent = session ? "Signed in as " + session.user.email : "";
  }
  sb.auth.onAuthStateChange((_event, s) => { session = s; updateAuthUI(); });
  async function initAuth() {
    const { data } = await sb.auth.getSession();
    session = data.session;
    updateAuthUI();
    if (session) loadSettings();
  }
  async function doLogin() {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    const err = $("loginError");
    if (!email || !password) { err.textContent = "Enter your email and password."; return; }
    $("loginBtn").disabled = true;
    err.textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $("loginBtn").disabled = false;
    if (error) { err.textContent = "Sign-in failed - check email and password."; return; }
    $("loginPassword").value = "";
    loadSettings();
  }
  $("loginBtn").addEventListener("click", doLogin);
  $("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("signOutBtn").addEventListener("click", async () => {
    await sb.auth.signOut();
    $("settingsSheet").hidden = true;
  });

  /* ---------- Tab navigation ---------- */
  function switchTab(tab) {
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("tab-" + tab).classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab)
    );
    if (tab === "inbox") { loadInbox(); loadNotifications(); }
    if (tab === "tasks") loadTasks();
    if (tab === "todo") loadTodos();
    if (tab === "chat") loadChatHistory();
  }
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  /* ---------- Settings ---------- */
  $("settingsBtn").addEventListener("click", () => ($("settingsSheet").hidden = false));
  $("closeSettings").addEventListener("click", () => ($("settingsSheet").hidden = true));
  $("settingsSheet").addEventListener("click", (e) => {
    if (e.target.id === "settingsSheet") $("settingsSheet").hidden = true;
  });
  $("listenDefault").addEventListener("change", async (e) => {
    listenDefault = e.target.checked;
    try { await sb.from("pa_settings").update({ listen_default: listenDefault, updated_at: new Date().toISOString() }).eq("id", 1); } catch (_) {}
  });
  async function loadSettings() {
    try {
      const { data } = await sb.from("pa_settings").select("listen_default").eq("id", 1).single();
      if (data) { listenDefault = !!data.listen_default; $("listenDefault").checked = listenDefault; }
    } catch (_) {}
    syncPushUI();
    // refresh badges on open so waiting cards/tasks/to-dos show without visiting the tabs
    loadInbox();
    loadTasks();
    loadTodos();
  }

  /* ---------- Push notifications (Slice 4) ---------- */
  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }
  function urlB64ToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function getSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function saveSubscription(sub) {
    const j = sub.toJSON();
    await sb.from("pa_push_subscriptions").upsert(
      { endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
      { onConflict: "endpoint" });
  }
  async function enablePush() {
    const note = $("pushNote");
    if (!pushSupported()) {
      note.textContent = "This phone/browser can't do app notifications. On iPhone, add the app to your Home Screen first, then try again.";
      return false;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      note.textContent = "Notifications are blocked. Allow them for this app in your phone settings, then flip this switch again.";
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(C.VAPID_PUBLIC_KEY),
        }));
      await saveSubscription(sub);
      setPushOptOut(false);
      note.textContent = "Notifications are on for this phone.";
      return true;
    } catch (e) {
      note.textContent = "Couldn't switch notifications on - try again.";
      return false;
    }
  }
  // Remembers a deliberate "off" so the self-heal in syncPushUI cannot switch
  // notifications back on behind her. Turning the toggle on clears it.
  const PUSH_OFF_KEY = "pa.pushOptOut";
  function pushOptedOut() {
    try { return localStorage.getItem(PUSH_OFF_KEY) === "1"; } catch (_) { return false; }
  }
  function setPushOptOut(v) {
    try { v ? localStorage.setItem(PUSH_OFF_KEY, "1") : localStorage.removeItem(PUSH_OFF_KEY); } catch (_) {}
  }
  async function disablePush() {
    setPushOptOut(true);
    try {
      const sub = await getSubscription();
      if (sub) {
        await sb.from("pa_push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (_) {}
    $("pushNote").textContent = "Get a notification when Claude needs a decision or finishes a task.";
  }
  async function syncPushUI() {
    try {
      if (!pushSupported() || Notification.permission !== "granted" || pushOptedOut()) {
        $("pushToggle").checked = false;
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      // Self-heal: permission is already granted, so re-subscribing here shows no
      // prompt. Push services expire endpoints (and pa-push prunes them on 404/410),
      // which used to leave the channel silently dead until the toggle was flipped
      // by hand. Re-subscribing on open puts a live address back in the table.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(C.VAPID_PUBLIC_KEY),
        });
      }
      $("pushToggle").checked = !!sub;
      // Keep the saved address fresh - endpoints rotate, and the row may have been
      // pruned while this phone still held a valid subscription.
      if (sub && session) await saveSubscription(sub);
    } catch (_) {
      try { $("pushToggle").checked = false; } catch (_) {}
    }
  }
  $("pushToggle").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const ok = await enablePush();
      if (!ok) e.target.checked = false;
    } else {
      await disablePush();
    }
  });

  /* ---------- Workspace picker ---------- */
  (function fillWorkspaces() {
    const sel = $("workspaceSelect");
    C.WORKSPACES.forEach((w) => {
      const o = document.createElement("option");
      o.value = w.id; o.textContent = w.label; sel.appendChild(o);
    });
  })();

  /* ---------- Voice recording (shared helper) ---------- */
  function makeRecorder(onDone) {
    let mediaRecorder = null, chunks = [];
    async function start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      chunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onDone(new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }));
      };
      mediaRecorder.start();
    }
    function stop() { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }
    return { start, stop };
  }

  async function transcribe(blob) {
    const fd = new FormData();
    fd.append("audio", blob, "voice.webm");
    const res = await fetch(webhook("transcribe"), { method: "POST", headers: authHeaders(), body: fd });
    if (!res.ok) throw new Error("transcribe failed");
    const data = await res.json();
    return data.text || data.transcript || "";
  }

  /* ---------- SEND TASK ---------- */
  let taskHasVoice = false;
  const sendRec = makeRecorder(async (blob) => {
    $("recordStatus").textContent = "Transcribing...";
    try {
      const text = await transcribe(blob);
      const ta = $("taskText");
      ta.value = ta.value ? ta.value + " " + text : text;
      if (text) taskHasVoice = true;
      $("recordStatus").textContent = "";
    } catch (e) {
      $("recordStatus").textContent = "Voice didn't come through - try again.";
    }
  });
  let sendRecording = false;
  function toggleSendRecord() {
    const btn = $("recordBtn");
    if (!sendRecording) {
      sendRec.start().then(() => {
        sendRecording = true;
        btn.classList.add("recording");
        $("recordLabel").textContent = "Tap to stop";
        $("recordStatus").textContent = "Listening...";
      }).catch(() => ($("recordStatus").textContent = "Mic permission needed"));
    } else {
      sendRec.stop(); sendRecording = false;
      btn.classList.remove("recording");
      $("recordLabel").textContent = "Hold to record";
    }
  }
  $("recordBtn").addEventListener("click", toggleSendRecord);

  /* ---------- Attachments (Slice 1b) ---------- */
  const ATT_BUCKET = "pa-attachments";
  const ATT_MAX_FILES = 10;
  const ATT_MAX_BYTES = 25 * 1024 * 1024; // matches the bucket's server-side cap
  let taskAttachments = []; // { path, name, type, size }
  let taskDraftId = null;   // uuid folder key, new per task
  let uploadsInFlight = 0;

  function renderAttachChips() {
    const wrap = $("attachChips");
    wrap.innerHTML = "";
    taskAttachments.forEach((a) => {
      const chip = document.createElement("div");
      chip.className = "att-chip";
      const icon = document.createElement("span");
      icon.textContent = (a.type || "").startsWith("image/") ? "\u{1F5BC}" : "\u{1F4C4}";
      const label = document.createElement("span");
      label.className = "att-name";
      label.textContent = a.name;
      const x = document.createElement("button");
      x.className = "att-remove";
      x.setAttribute("aria-label", "Remove " + a.name);
      x.textContent = "✕";
      x.addEventListener("click", async () => {
        taskAttachments = taskAttachments.filter((t) => t.path !== a.path);
        renderAttachChips();
        try { await sb.storage.from(ATT_BUCKET).remove([a.path]); } catch (_) {}
      });
      chip.appendChild(icon); chip.appendChild(label); chip.appendChild(x);
      wrap.appendChild(chip);
    });
  }

  $("attachBtn").addEventListener("click", () => {
    const st = $("attachStatus");
    if (!session) { st.textContent = "Sign in first."; return; }
    st.textContent = "";
    $("attachInput").click();
  });

  $("attachInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-picking the same file
    const st = $("attachStatus");
    for (const file of files) {
      if (taskAttachments.length >= ATT_MAX_FILES) { st.textContent = "Max " + ATT_MAX_FILES + " files per task."; break; }
      if (file.size > ATT_MAX_BYTES) { st.textContent = file.name + " is over 25 MB - skipped."; continue; }
      if (!taskDraftId) taskDraftId = crypto.randomUUID();
      // safe storage key: keep letters/digits/dot/dash/underscore
      let name = (file.name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 100) || "file";
      let n = 1;
      while (taskAttachments.some((a) => a.name === name)) name = (n++) + "-" + name;
      const path = "tasks/" + taskDraftId + "/" + name;
      uploadsInFlight++;
      st.textContent = "Uploading " + name + "...";
      try {
        const { error } = await sb.storage.from(ATT_BUCKET)
          .upload(path, file, { contentType: file.type || "application/octet-stream" });
        if (error) throw error;
        taskAttachments.push({ path, name, type: file.type || "application/octet-stream", size: file.size });
        renderAttachChips();
        st.textContent = "";
      } catch (err) {
        st.textContent = "Couldn't upload " + name + " - try again.";
      } finally {
        uploadsInFlight--;
      }
    }
  });

  /* ---------- Tidy up (Slice 5: voice memo -> structured task + suggested workspace) ---------- */
  $("tidyBtn").addEventListener("click", async () => {
    const st = $("tidyStatus");
    const ta = $("taskText");
    const text = ta.value.trim();
    if (!session) { st.textContent = "Sign in first."; return; }
    if (!text) { st.textContent = "Nothing to tidy yet - speak or type first."; return; }
    $("tidyBtn").disabled = true;
    st.textContent = "Tidying...";
    try {
      const res = await fetch(webhook("structure"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("structure failed");
      const data = await res.json();
      if (data.task) ta.value = data.task;
      // Suggest the workspace when she left the picker on Auto
      if (data.workspace && $("workspaceSelect").value === "auto") {
        $("workspaceSelect").value = data.workspace;
        const label = (C.WORKSPACES.find((w) => w.id === data.workspace) || {}).label || data.workspace;
        st.textContent = "Tidied - I'd send this to " + label + ". Change it if I'm wrong.";
      } else {
        st.textContent = "Tidied - check it reads right.";
      }
    } catch (e) {
      st.textContent = "Couldn't tidy that - you can still send it as-is.";
    } finally {
      $("tidyBtn").disabled = false;
    }
  });

  $("sendTaskBtn").addEventListener("click", async () => {
    const workspace = $("workspaceSelect").value;
    const task = $("taskText").value.trim();
    const out = $("sendResult");
    if (!task) { out.className = "result-line err"; out.textContent = "Type or record a task first."; return; }
    if (uploadsInFlight > 0) { out.className = "result-line err"; out.textContent = "Wait a moment - a file is still uploading."; return; }
    $("sendTaskBtn").disabled = true;
    out.className = "result-line"; out.textContent = "Sending...";
    try {
      const res = await fetch(webhook("sendTask"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ workspace, task, source: taskHasVoice ? "voice" : "text", attachments: taskAttachments }),
      });
      if (!res.ok) throw new Error("send failed");
      out.className = "result-line ok"; out.textContent = "Sent. It'll be picked up within the hour - track it on the Tasks tab.";
      $("taskText").value = "";
      taskHasVoice = false;
      taskAttachments = []; taskDraftId = null; renderAttachChips();
      // the workflow records the task server-side; refresh the Tasks badge
      loadTasks();
    } catch (e) {
      out.className = "result-line err";
      out.textContent = session ? "Couldn't send - check your connection and try again." : "Please sign in first.";
    } finally {
      $("sendTaskBtn").disabled = false;
    }
  });

  /* ---------- CHAT ---------- */
  const chatScroll = $("chatScroll");
  function addBubble(role, text, opts = {}) {
    $("chatEmpty") && ($("chatEmpty").style.display = "none");
    const b = document.createElement("div");
    b.className = "bubble " + role;
    b.textContent = text;
    chatScroll.appendChild(b);
    if (role === "assistant" && !opts.noListen) {
      const row = document.createElement("div");
      row.className = "bubble-actions";
      const lb = document.createElement("button");
      lb.className = "listen-btn"; lb.textContent = "🔊 Listen";
      lb.addEventListener("click", () => speak(text));
      row.appendChild(lb);
      chatScroll.appendChild(row);
    }
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return b;
  }

  async function speak(text) {
    try {
      const res = await fetch(webhook("speak"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("tts failed");
      const blob = await res.blob();
      new Audio(URL.createObjectURL(blob)).play();
    } catch (e) {
      // Fallback to the phone's built-in voice
      if (window.speechSynthesis) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      }
    }
  }

  async function sendChat(message) {
    if (!message.trim()) return;
    addBubble("user", message);
    $("chatInput").value = "";
    // history is stored server-side by the PA - Chat workflow (both roles)
    const typing = addBubble("assistant", "...", { noListen: true });
    typing.classList.add("typing");
    try {
      const res = await fetch(webhook("chat"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error("chat failed");
      const data = await res.json();
      const reply = data.reply || data.text || "(no reply)";
      typing.remove();
      addBubble("assistant", reply);
      if (listenDefault) speak(reply);
    } catch (e) {
      typing.remove();
      addBubble("assistant", "Chat backend isn't live yet - it'll answer once the n8n chat workflow is deployed.");
    }
  }
  $("chatSendBtn").addEventListener("click", () => sendChat($("chatInput").value));
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat($("chatInput").value); });
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () =>
      c.dataset.chip === "__brief" ? morningBrief() : sendChat(c.dataset.chip))
  );

  /* ---------- Morning brief (Slice 5) - fetched server-side, spoken aloud ---------- */
  let briefRunning = false;
  async function morningBrief() {
    if (briefRunning) return;
    briefRunning = true;
    addBubble("user", "Morning brief, please");
    const typing = addBubble("assistant", "Pulling your brief together...", { noListen: true });
    typing.classList.add("typing");
    try {
      const res = await fetch(webhook("brief"), {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      if (!res.ok) throw new Error("brief failed");
      const data = await res.json();
      const brief = data.brief || "I couldn't put a brief together just now - try again in a minute.";
      typing.remove();
      addBubble("assistant", brief);
      speak(brief); // the point of the brief is hearing it - always spoken
    } catch (e) {
      typing.remove();
      addBubble("assistant", "I couldn't fetch your brief - check your connection and try again.");
    } finally {
      briefRunning = false;
    }
  }

  const chatRec = makeRecorder(async (blob) => {
    try { const text = await transcribe(blob); if (text) sendChat(text); } catch (_) {}
  });
  let chatRecording = false;
  $("chatRecordBtn").addEventListener("click", () => {
    const btn = $("chatRecordBtn");
    if (!chatRecording) {
      chatRec.start().then(() => { chatRecording = true; btn.classList.add("recording"); }).catch(() => {});
    } else {
      chatRec.stop(); chatRecording = false; btn.classList.remove("recording");
    }
  });

  let chatLoaded = false;
  async function loadChatHistory() {
    if (chatLoaded) return;
    chatLoaded = true;
    try {
      const { data } = await sb.from("pa_messages").select("role,content").order("created_at", { ascending: true }).limit(40);
      if (data && data.length) data.forEach((m) => addBubble(m.role, m.content, { noListen: m.role === "user" }));
    } catch (_) {}
  }

  /* ---------- INBOX (cards FROM the PA) + TASKS (what Tarryn sent) ----------
     Split per Tarryn's 2026-06-05 card answer: Inbox = decision cards/messages
     from the PA; Tasks = the tasks and plans she sends, with status. */
  function wsLabel(id) { return (C.WORKSPACES.find((w) => w.id === id) || {}).label || id; }

  async function answerDecision(id, answer, cardEl) {
    if (!answer || !answer.trim()) return;
    cardEl.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
    try {
      const { error } = await sb.from("pa_decisions")
        .update({ status: "answered", answer: answer.trim(), answered_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      cardEl.innerHTML = '<div class="ws">Answered</div><div class="txt">Got it - "' + escapeHtml(answer.trim()) + '". I\'ll act on this at my next work cycle (I run every morning and afternoon).</div>';
      cardEl.classList.add("answered");
      setTimeout(loadInbox, 2500);
    } catch (e) {
      cardEl.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
      alert("Couldn't save your answer - check your connection and try again.");
    }
  }

  function renderDecisionCard(d) {
    const card = document.createElement("div");
    card.className = "inbox-card decision-card";
    const opts = Array.isArray(d.options) ? d.options : [];
    card.innerHTML =
      '<div class="ws">Decision needed - ' + escapeHtml(wsLabel(d.workspace)) + '</div>' +
      (d.layman_recap ? '<div class="recap">' + escapeHtml(d.layman_recap) + '</div>' : '') +
      '<div class="txt">' + escapeHtml(d.question) + '</div>' +
      '<div class="opt-row"></div>' +
      '<div class="ans-row"><button class="icon-btn mic-btn ans-mic" aria-label="Speak your answer">&#127908;</button>' +
      '<input type="text" placeholder="Or type / speak an answer..." enterkeyhint="send"><button class="ans-send">Send</button></div>' +
      '<div class="meta"><span>' + new Date(d.created_at).toLocaleString() + '</span></div>';
    const optRow = card.querySelector(".opt-row");
    opts.forEach((o) => {
      const b = document.createElement("button");
      b.className = "opt-btn";
      b.textContent = o;
      b.addEventListener("click", () => answerDecision(d.id, o, card));
      optRow.appendChild(b);
    });
    const input = card.querySelector("input");
    const sendBtn = card.querySelector(".ans-send");
    sendBtn.addEventListener("click", () => answerDecision(d.id, input.value, card));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") answerDecision(d.id, input.value, card); });
    // Voice answer: record -> Whisper -> transcript lands in the input so she
    // can check or edit it, then taps Send. (Same recorder as the Send tab.)
    const micBtn = card.querySelector(".ans-mic");
    let micRecording = false;
    const micRec = makeRecorder(async (blob) => {
      input.placeholder = "Transcribing...";
      try {
        const text = await transcribe(blob);
        if (text) input.value = input.value ? input.value + " " + text : text;
        input.placeholder = "Or type / speak an answer...";
        input.focus();
      } catch (_) {
        input.placeholder = "Voice didn't come through - try again.";
      }
    });
    micBtn.addEventListener("click", () => {
      if (!micRecording) {
        micRec.start().then(() => { micRecording = true; micBtn.classList.add("recording"); }).catch(() => {});
      } else {
        micRec.stop(); micRecording = false; micBtn.classList.remove("recording");
      }
    });
    return card;
  }

  async function loadInbox() {
    const list = $("inboxList");
    try {
      const { data } = await sb.from("pa_decisions").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(20);
      const decisions = data || [];
      if (!decisions.length) {
        list.innerHTML = '<div class="inbox-empty">Nothing waiting on you.</div>';
      } else {
        list.innerHTML = "";
        decisions.forEach((d) => list.appendChild(renderDecisionCard(d)));
      }
      setBadge("inboxBadge", decisions.length);
    } catch (e) {
      list.innerHTML = '<div class="inbox-empty">Could not load - check connection.</div>';
    }
  }

  async function loadNotifications() {
    const list = $("notifyList");
    if (!list) return;
    try {
      const { data } = await sb.from("pa_notifications").select("*").order("created_at", { ascending: false }).limit(30);
      const rows = data || [];
      if (!rows.length) {
        list.innerHTML = '<div class="inbox-empty">No notifications yet.</div>';
      } else {
        list.innerHTML = "";
        rows.forEach((n) => {
          const card = document.createElement("div");
          card.className = "inbox-card";
          card.innerHTML =
            '<div class="txt"><strong>' + escapeHtml(n.title || "My PA") + '</strong></div>' +
            '<div class="txt">' + escapeHtml(n.body || "") + '</div>' +
            '<div class="meta"><span>' + new Date(n.created_at).toLocaleString() + '</span></div>';
          list.appendChild(card);
        });
      }
      // Mark everything shown as read so the unread count reflects reality.
      const unread = rows.filter((n) => !n.read_at).map((n) => n.id);
      if (unread.length) {
        await sb.from("pa_notifications").update({ read_at: new Date().toISOString() }).in("id", unread);
      }
    } catch (e) {
      list.innerHTML = '<div class="inbox-empty">Could not load - check connection.</div>';
    }
  }

  async function loadTasks() {
    const list = $("tasksList");
    try {
      const { data } = await sb.from("pa_tasks").select("*").order("created_at", { ascending: false }).limit(30);
      const taskRows = data || [];
      if (!taskRows.length) {
        list.innerHTML = '<div class="inbox-empty">Nothing here yet - send me a task from the Send tab.</div>';
      } else {
        list.innerHTML = "";
        taskRows.forEach((t) => {
          const card = document.createElement("div");
          card.className = "inbox-card";
          const attCount = Array.isArray(t.attachments) ? t.attachments.length : 0;
          const attIcon = attCount ? '<span class="att-count">&#128206;' + attCount + '</span>' : '';
          card.innerHTML =
            '<div class="ws">' + wsLabel(t.workspace) + '</div>' +
            '<div class="txt">' + escapeHtml(t.task_text) + '</div>' +
            '<div class="meta"><span>' + new Date(t.created_at).toLocaleString() + attIcon + '</span>' +
            '<span class="status-pill ' + t.status + '">' + t.status.replace("_", " ") + '</span></div>';
          list.appendChild(card);
        });
      }
      setBadge("tasksBadge", taskRows.filter((t) => t.status === "queued" || t.status === "picked_up").length);
    } catch (e) {
      list.innerHTML = '<div class="inbox-empty">Could not load - check connection.</div>';
    }
  }

  function setBadge(id, n) {
    const badge = $(id);
    if (n > 0) { badge.hidden = false; badge.textContent = n; } else { badge.hidden = true; }
  }

  /* ---------- TO-DO (shared list - Tarryn + PA both add; Tarryn ticks off) ---------- */
  async function loadTodos() {
    const list = $("todoList");
    try {
      const { data } = await sb.from("pa_todos").select("*")
        .order("done", { ascending: true }).order("created_at", { ascending: false }).limit(60);
      const todos = data || [];
      if (!todos.length) {
        list.innerHTML = '<div class="inbox-empty">Nothing on the list.</div>';
      } else {
        list.innerHTML = "";
        todos.forEach((t) => {
          const row = document.createElement("div");
          row.className = "todo-row" + (t.done ? " done" : "");
          const tick = document.createElement("button");
          tick.className = "todo-tick";
          tick.setAttribute("aria-label", t.done ? "Mark as not done" : "Mark as done");
          tick.textContent = t.done ? "✓" : "";
          tick.addEventListener("click", async () => {
            const nowDone = !t.done;
            try {
              await sb.from("pa_todos").update({ done: nowDone, done_at: nowDone ? new Date().toISOString() : null }).eq("id", t.id);
              loadTodos();
            } catch (_) {}
          });
          const label = document.createElement("div");
          label.className = "todo-text";
          label.textContent = t.text;
          const by = document.createElement("div");
          by.className = "todo-by";
          by.textContent = (t.added_by === "pa" ? "added by your PA" : "added by you") +
            " - " + new Date(t.created_at).toLocaleDateString();
          const main = document.createElement("div");
          main.className = "todo-main";
          main.appendChild(label); main.appendChild(by);
          row.appendChild(tick); row.appendChild(main);
          list.appendChild(row);
        });
      }
      setBadge("todoBadge", todos.filter((t) => !t.done).length);
    } catch (e) {
      list.innerHTML = '<div class="inbox-empty">Could not load - check connection.</div>';
    }
  }
  async function addTodo() {
    const input = $("todoInput");
    const text = input.value.trim();
    if (!text || !session) return;
    $("todoAddBtn").disabled = true;
    try {
      await sb.from("pa_todos").insert({ text, added_by: "tarryn" });
      input.value = "";
      loadTodos();
    } catch (_) {
      alert("Couldn't add that - check your connection and try again.");
    } finally {
      $("todoAddBtn").disabled = false;
    }
  }
  $("todoAddBtn").addEventListener("click", addTodo);
  $("todoInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  /* ---------- Offline banner (Slice 6) ---------- */
  function syncOnlineUI() { $("offlineBanner").hidden = navigator.onLine; }
  window.addEventListener("online", syncOnlineUI);
  window.addEventListener("offline", syncOnlineUI);
  syncOnlineUI();

  /* ---------- Service worker ---------- */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  /* ---------- Init ---------- */
  initAuth();
})();

  /* ---------- Opened from a notification ---------- */
  // The service worker sends us here after a tap. Without this, focusing an
  // already-open window left it on whatever tab it happened to be showing.
  function openFromHash() {
    const t = (location.hash || "").replace("#", "");
    if (["send", "chat", "tasks", "todo", "inbox"].includes(t)) switchTab(t);
  }
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
  navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "navigate" && e.data.tab) switchTab(e.data.tab);
  });
