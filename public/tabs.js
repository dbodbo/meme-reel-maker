// Abas: Editor / Criar template / Tutorial (a aba atual fica na URL: #editor, #template, #tutorial)
const TABS = ['editor', 'template', 'tutorial'];

function showTab() {
  const name = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'editor';
  for (const t of TABS) document.getElementById(`tab-${t}`).hidden = t !== name;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === name);
}

addEventListener('hashchange', showTab);
showTab();
