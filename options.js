const $ = id => document.getElementById(id);
const KROKI = ["odbuduj", "odswiez", "kopiuj", "sortuj", "duplikaty", "kosz", "oproznij"];
const POLA = ["podglad", ...KROKI, "autoStart", "autoCo"];

const T = {
  pl: {
    wersja: "poczta tylko lokalnie · wersja",
    hAuto: "Uruchamiaj automatycznie",
    autoStart: "1. po starcie Thunderbirda (po 3 min)",
    autoCo1: "2. co", autoCo2: "min (najmniej 5)",
    hKonto: "Skrzynka",
    kontoOpis: "Wpisz adres lub nazwę konta albo wybierz z listy. „*” = wszystkie skrzynki. Każda skrzynka X potrzebuje konta lokalnego „X - lokalne”.",
    wszystkie: "wszystkie skrzynki",
    hKroki: "Kroki cyklu (każda skrzynka osobno, po kolei)",
    podglad: "podgląd: tylko dziennik i indeks, nic nie zmienia",
    k1: "odbuduj indeksy lokalne (otwiera kolejno foldery lokalne; wolne, tylko po zmianach spoza Thunderbirda)",
    k1s: "odśwież foldery serwera (otwiera każdy folder skrzynki, żeby Thunderbird pobrał aktualną listę wiadomości)",
    k2: "kopiuj z serwera do lokalnych (z potwierdzeniem kopii; gwiazdki, etykiety, przeczytane)",
    k3: "sortuj lokalne Odebrane do podfolderów nadawców",
    k4: "usuń duplikaty lokalne (ten sam Message-ID w folderze → lokalny Kosz)",
    k5: "przenieś do kosza serwera wszystko, co ma kopię lokalną (także Gmail: Wszystkie, Odebrane, Spam)",
    k6: "opróżnij kosze: z kosza serwera tylko wiadomości z kopią lokalną; lokalny Kosz w całości",
    zapisz: "Zapisz ustawienia", teraz: "Uruchom cykl", stop: "Przerwij",
    pracuje: "cykl trwa...", wolne: "bez cyklu",
    hIndeks: "Indeks: serwer ↔ lokalnie",
    indeksOpis: "Po każdym cyklu (także podglądzie): unikalne wiadomości na serwerze i ile z nich ma kopię lokalną.",
    kol: ["skrzynka", "na serwerze", "z kopią lokalną", "brakuje", "gwiazdka", "etykiety", "archiwum", "stan z"],
    hDziennik: "Dziennik",
    dziennikOpis: "Adresy zamaskowane, bez tematów.",
    plik: "Pobierz dziennik", wyczysc: "Wyczyść dziennik",
    podgladWl: "PODGLĄD WŁĄCZONY: cykl nic nie zmienia",
    kroki: "kroki", brakKrokow: "brak", skrzynka: "skrzynka", auto: "automatycznie", nie: "nie",
    pytWszystkie: "Uruchomić cykl na WSZYSTKICH skrzynkach?",
    pytKasuj: "UWAGA: zaznaczone kroki usuwają dane.\n\n6: oryginały na serwerze trafią do kosza serwera.\n7: wiadomości z kopią lokalną zostaną usunięte z kosza serwera NA STAŁE, lokalny Kosz zostanie opróżniony NA STAŁE.\n\nTego nie da się cofnąć. Kontynuować?",
  },
  en: {
    wersja: "local-only email storage · version",
    hAuto: "Run automatically",
    autoStart: "1. after Thunderbird starts (after 3 min)",
    autoCo1: "2. every", autoCo2: "min (at least 5)",
    hKonto: "Mailbox",
    kontoOpis: "Type an address or account name, or pick from the list. \"*\" = all mailboxes. Each mailbox X needs a local account \"X - lokalne\".",
    wszystkie: "all mailboxes",
    hKroki: "Cycle steps (each mailbox separately, in turn)",
    podglad: "preview: log and index only, changes nothing",
    k1: "rebuild local indexes (opens local folders one by one; slow, only after changes made outside Thunderbird)",
    k1s: "refresh server folders (opens every mailbox folder so Thunderbird fetches the current message list)",
    k2: "copy from server to local (copy confirmed; stars, tags, read state)",
    k3: "sort local Inbox into per-sender subfolders",
    k4: "remove local duplicates (same Message-ID in a folder → local Trash)",
    k5: "move everything that has a local copy to server trash (incl. Gmail All Mail, Inbox, Spam)",
    k6: "empty trash: server trash only messages with a local copy; local Trash entirely",
    zapisz: "Save settings", teraz: "Run cycle", stop: "Stop",
    pracuje: "cycle running...", wolne: "idle",
    hIndeks: "Index: server ↔ local",
    indeksOpis: "After each cycle (preview too): unique messages on the server and how many have a local copy.",
    kol: ["mailbox", "on server", "local copy", "missing", "starred", "tagged", "archived", "as of"],
    hDziennik: "Log",
    dziennikOpis: "Addresses masked, no subjects.",
    plik: "Download log", wyczysc: "Clear log",
    podgladWl: "PREVIEW ON: the cycle changes nothing",
    kroki: "steps", brakKrokow: "none", skrzynka: "mailbox", auto: "automatic", nie: "no",
    pytWszystkie: "Run the cycle on ALL mailboxes?",
    pytKasuj: "WARNING: the selected steps delete data.\n\n6: server originals go to server trash.\n7: messages with a local copy are deleted PERMANENTLY from server trash, local Trash is emptied PERMANENTLY.\n\nThis cannot be undone. Continue?",
  },
};
const t = T[(browser.i18n.getUILanguage() || "en").toLowerCase().startsWith("pl") ? "pl" : "en"];

function przetlumacz() {
  document.documentElement.lang = t === T.pl ? "pl" : "en";
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t[el.dataset.t];
}

async function wczytaj() {
  przetlumacz();
  const st = await browser.runtime.sendMessage({ co: "stan" });
  const u = st.ustawienia;
  for (const x of POLA) $(x).checked = !!u[x];
  $("konto").value = u.konto || "";
  $("interwal").value = u.interwal;
  $("wersja").textContent = `${t.wersja} ${st.wersja}`;
  const lista = $("konta");
  const o = document.createElement("option");
  o.value = "*"; o.label = t.wszystkie; lista.appendChild(o);
  for (const n of await browser.runtime.sendMessage({ co: "konta" })) {
    const e = document.createElement("option"); e.value = n; lista.appendChild(e);
  }
  await odswiez();
}

function tabela(indeks) {
  const tb = $("indeks");
  tb.textContent = "";
  const nazwy = Object.keys(indeks || {}).sort();
  if (!nazwy.length) return;
  const tr = tb.insertRow();
  for (const k of t.kol) { const th = document.createElement("th"); th.textContent = k; tr.appendChild(th); }
  for (const n of nazwy) {
    const x = indeks[n], r = tb.insertRow();
    for (const [i, v] of [n, x.unikalnych, x.lokalnie, x.brakuje, x.gwiazdki, x.etykiety, x.archiwum, x.czas].entries()) {
      const c = r.insertCell(); c.textContent = v;
      if (i === 3 && v > 0) c.className = "brak";
    }
  }
}

async function odswiez() {
  const ta = $("dziennik");
  const naDole = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 20;
  ta.value = (await browser.runtime.sendMessage({ co: "dziennik" })) || "";
  if (naDole) ta.scrollTop = ta.scrollHeight;
  const st = await browser.runtime.sendMessage({ co: "stan" });
  if (!st) return;
  const u = st.ustawienia || {};
  $("stan").textContent = st.pracuje ? t.pracuje : t.wolne;
  $("stop").disabled = !st.pracuje;
  $("teraz").disabled = st.pracuje;
  const kroki = KROKI.map((x, i) => u[x] ? i + 1 : null).filter(Boolean).join(", ") || t.brakKrokow;
  const auto = [u.autoStart ? "1" : "", u.autoCo ? `2 (${u.interwal} min)` : ""].filter(Boolean).join(" + ") || t.nie;
  $("aktywne").className = u.podglad ? "uwaga" : "opis";
  $("aktywne").textContent = (u.podglad ? t.podgladWl + " | " : "") +
    `${t.kroki}: ${kroki} | ${t.skrzynka}: ${u.konto && u.konto !== "*" ? u.konto : t.wszystkie} | ${t.auto}: ${auto}`;
  tabela(st.indeks);
}

function formularz() {
  const u = { konto: $("konto").value.trim(), interwal: Math.max(5, Number($("interwal").value) || 60) };
  for (const x of POLA) u[x] = $(x).checked;
  return u;
}
function potwierdz(u) {
  if ((!u.konto || u.konto === "*") && !confirm(t.pytWszystkie)) return false;
  if (!u.podglad && (u.kosz || u.oproznij) && !confirm(t.pytKasuj)) return false;
  return true;
}

$("zapisz").onclick = async () => {
  const u = formularz();
  if ((u.autoStart || u.autoCo) && !potwierdz(u)) return;
  await browser.runtime.sendMessage({ co: "ustawienia", ustawienia: u });
  await odswiez();
};
$("teraz").onclick = async () => {
  const u = formularz();
  if (!potwierdz(u)) return;
  await browser.runtime.sendMessage({ co: "cykl", ustawienia: u });
  setTimeout(odswiez, 1500);
};
$("stop").onclick = async () => { await browser.runtime.sendMessage({ co: "przerwij" }); await odswiez(); };
$("wyczysc").onclick = async () => { await browser.runtime.sendMessage({ co: "wyczysc" }); await odswiez(); };
$("plik").onclick = () => {
  const blob = new Blob([$("dziennik").value + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mailvault-log.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

setInterval(odswiez, 5000);
wczytaj();
