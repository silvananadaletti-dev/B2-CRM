// Aba "Administração" — CRUD de usuários com login (admin vê tudo, vendedor só
// vê os próprios leads). Só é chamada quando o usuário logado é admin (ver
// app.js: aba escondida e render() só delega aqui se isAdmin()).
(function () {
  let users = [];
  let editingUserId = null;
  let loaded = false;

  function escapeAdminHtml(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[m]);
  }

  function roleLabel(role) {
    return role === "admin" ? "Administrador" : "Vendedor";
  }

  function renderTable() {
    const tbody = document.getElementById("admin-users-tbody");
    tbody.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeAdminHtml(u.nome || "—")}</td>
        <td>${escapeAdminHtml(u.username)}</td>
        <td><span class="admin-role-pill admin-role-${u.role}">${roleLabel(u.role)}</span></td>
        <td>${escapeAdminHtml(u.vendedor || "—")}</td>
        <td><span class="admin-status-pill ${u.active ? "admin-status-active" : "admin-status-inactive"}">${u.active ? "Ativo" : "Inativo"}</span></td>
        <td><button class="admin-edit-link">Editar</button></td>
      `;
      tr.querySelector(".admin-edit-link").addEventListener("click", () => openModal(u));
      tbody.appendChild(tr);
    });
  }

  function vendedorOptions() {
    return (typeof state !== "undefined" && state.meta && state.meta.vendedor_options && state.meta.vendedor_options.length)
      ? state.meta.vendedor_options
      : ["Augusto", "Luciano", "Jair", "Flávio", "Jorge", "Renan"];
  }

  function updateVendedorVisibility() {
    const role = document.getElementById("au-role").value;
    document.getElementById("au-vendedor-wrap").classList.toggle("hidden", role !== "vendedor");
  }

  function openModal(user) {
    editingUserId = user ? user.id : null;
    document.getElementById("admin-user-modal-title").textContent = user ? "Editar usuário" : "Novo usuário";
    document.getElementById("au-nome").value = user ? user.nome || "" : "";
    document.getElementById("au-username").value = user ? user.username : "";
    document.getElementById("au-username").disabled = !!user; // login não muda depois de criado
    document.getElementById("au-role").value = user ? user.role : "vendedor";
    const vSel = document.getElementById("au-vendedor");
    vSel.innerHTML = vendedorOptions().map((v) => `<option value="${escapeAdminHtml(v)}">${escapeAdminHtml(v)}</option>`).join("");
    vSel.value = user ? user.vendedor || "" : "";
    updateVendedorVisibility();
    document.getElementById("au-password").value = "";
    document.getElementById("au-password").placeholder = user ? "Deixe em branco para manter a senha atual" : "Defina uma senha inicial";
    document.getElementById("au-active").checked = user ? !!user.active : true;
    document.getElementById("admin-user-delete-btn").classList.toggle("hidden", !user);
    document.getElementById("admin-user-error").classList.add("hidden");
    document.getElementById("admin-user-modal").classList.remove("hidden");
  }

  function closeModal() {
    document.getElementById("admin-user-modal").classList.add("hidden");
  }

  async function loadUsers() {
    users = await api("/admin/users");
    renderTable();
  }

  async function handleSave() {
    const errEl = document.getElementById("admin-user-error");
    errEl.classList.add("hidden");
    const nome = document.getElementById("au-nome").value.trim();
    const username = document.getElementById("au-username").value.trim().toLowerCase();
    const role = document.getElementById("au-role").value;
    const vendedor = document.getElementById("au-vendedor").value;
    const password = document.getElementById("au-password").value;
    const active = document.getElementById("au-active").checked;

    try {
      if (editingUserId) {
        const payload = { nome, role, vendedor, active };
        if (password) payload.password = password;
        await api(`/admin/users/${editingUserId}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        if (!username) { throw new Error("Informe o usuário (login)."); }
        if (!password) { throw new Error("Defina uma senha inicial."); }
        await api("/admin/users", {
          method: "POST",
          body: JSON.stringify({ username, password, role, vendedor, nome }),
        });
      }
      closeModal();
      await loadUsers();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    }
  }

  async function handleDelete() {
    if (!editingUserId) return;
    if (!confirm("Excluir este usuário? Ele perde o acesso imediatamente.")) return;
    const errEl = document.getElementById("admin-user-error");
    try {
      await api(`/admin/users/${editingUserId}`, { method: "DELETE" });
      closeModal();
      await loadUsers();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    }
  }

  function wire() {
    document.getElementById("admin-new-user-btn").addEventListener("click", () => openModal(null));
    document.getElementById("admin-user-modal-close").addEventListener("click", closeModal);
    document.getElementById("admin-user-cancel-btn").addEventListener("click", closeModal);
    document.getElementById("admin-user-modal").addEventListener("click", (e) => {
      if (e.target.id === "admin-user-modal") closeModal();
    });
    document.getElementById("au-role").addEventListener("change", updateVendedorVisibility);
    document.getElementById("admin-user-save-btn").addEventListener("click", handleSave);
    document.getElementById("admin-user-delete-btn").addEventListener("click", handleDelete);
  }

  let wired = false;

  window.AdminPanel = {
    show: function () {
      if (!wired) { wire(); wired = true; }
      loadUsers().catch((err) => {
        alert("Erro ao carregar usuários: " + err.message);
      });
      loaded = true;
    },
  };
})();
