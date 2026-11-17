// MailVault — poczta tylko lokalnie / local-only email storage
// Dla każdej skrzynki IMAP "X" z kontem lokalnym "X - lokalne" wykonuje cykl (skrzynka po skrzynce):
//   1. odbudowa indeksów lokalnych (opcjonalnie; foldery bez aktualnego indeksu są niewidoczne dla dodatku)
//   2. odświeżenie folderów serwera (otwiera każdy folder: Thunderbird pobiera aktualną listę wiadomości)
//   3. kopia z serwera do konta lokalnego (z potwierdzeniem; z przeniesieniem gwiazdki, etykiet, stanu przeczytania)
//        Wysłane -> Sent, Wersje robocze -> Drafts, Szablony -> Drafts/Szablony, Archiwum -> Archives,
//        Gmail: tylko w Wszystkie (zarchiwizowane) -> Archives,
//        reszta (Odebrane, Spam, Wszystkie, własne foldery, Kosz) -> Inbox/<adres nadawcy>
//   4. sortowanie lokalnego Odebrane do podfolderów nadawców
//   5. usunięcie duplikatów lokalnych (ten sam Message-ID w tym samym folderze -> lokalny Kosz)
//   6. przeniesienie oryginałów z potwierdzoną kopią lokalną do kosza serwera
//   7. opróżnienie koszy: z kosza serwera tylko wiadomości z kopią lokalną; lokalny Kosz w całości
// "podgląd" = tylko dziennik i indeks porównawczy, bez zmian.
// Dziennik bez tematów, adresy zamaskowane.

const KROKI = ["odbuduj", "odswiez", "kopiuj", "sortuj", "duplikaty", "kosz", "oproznij"];
const DOMYSLNE = {
  konto: "", podglad: true,
  odbuduj: false, odswiez: true, kopiuj: true, sortuj: true, duplikaty: false, kosz: false, oproznij: false,
  autoStart: false, autoCo: false, interwal: 60,
};
const MAX_DZIENNIK = 5000;
let ustawienia = { ...DOMYSLNE };
let dziennik = [];
let indeks = {};            // nazwa skrzynki -> { czas, unikalnych, lokalnie, brakuje, gwiazdki, etykiety, archiwum }
let oczekujace = {};        // Message-ID -> { t: czas ostatniej próby kopii bez potwierdzenia, n: liczba prób }
let pracuje = false;
let przerwij = false;
let zapisDziennika = null;

class Przerwano extends Error {}
class LimitCzasu extends Error {}

// każde wywołanie Thunderbirda z limitem czasu; "przerwij" przerywa także wywołanie, które zawisło
let przerwanie;
function nowePrzerwanie() {
  let odrzuc;
  const p = new Promise((_, r) => { odrzuc = r; });
  p.catch(() => {});
  przerwanie = { p, odrzuc };
}
nowePrzerwanie();
function B(obietnica, ms, co) {
  let t;
  const limit = new Promise((_, r) => { t = setTimeout(() => r(new LimitCzasu(`${co}: brak odpowiedzi od ${ms / 1000} s`)), ms); });
  return Promise.race([obietnica, limit, przerwanie.p]).finally(() => clearTimeout(t));
}

// ---------- dziennik ----------
function maska(t) {
  return String(t).replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, "$1***@$2");
}
function czas() {
  const d = new Date(), z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
async function log(t) {
  const linia = `${czas()} ${maska(t)}`;
  dziennik.push(linia);
  if (dziennik.length > MAX_DZIENNIK) dziennik = dziennik.slice(-MAX_DZIENNIK);
  console.log("[mailvault] " + linia);
  if (!zapisDziennika) {
    zapisDziennika = setTimeout(async () => {
      zapisDziennika = null;
      try { await browser.storage.local.set({ dziennik, indeks }); } catch (e) { /* bez znaczenia */ }
    }, 3000);
  }
}

// ---------- pomocnicze ----------
const czekaj = ms => new Promise(r => setTimeout(r, ms));
function sprawdzPrzerwanie() { if (przerwij) throw new Przerwano(); }

function adresNadawcy(author) {
  const m = String(author || "").match(/<([^>]+)>/);
  const a = (m ? m[1] : String(author || "")).trim().toLowerCase();
  return a.includes("@") ? a.replace(/[\/\\]/g, "_").slice(0, 100) : "bez-nadawcy";
}
async function* wszystkie(folder) {
  let lista = await B(browser.messages.list(folder), 120000, "messages.list");
  while (true) {
    for (const m of lista.messages) { sprawdzPrzerwanie(); yield m; }
    if (!lista.id) break;
    lista = await B(browser.messages.continueList(lista.id), 120000, "messages.continueList");
  }
}
function splaszcz(foldery, wynik = []) {
  for (const f of foldery || []) { wynik.push(f); splaszcz(f.subFolders, wynik); }
  return wynik;
}
function czyKosz(f) {
  return f.type === "trash" || /(^|\/)(trash|kosz|deleted( items| messages)?|bin|papierkorb)$/i.test(f.path);
}
function czyWszystkie(f) {   // Gmail: folder ze wszystkimi wiadomościami
  return /\[gmail\]\/(all mail|wszystkie)$/i.test(f.path) || f.type === "all";
}
function czyArchiwum(f) {
  return !czyWszystkie(f) && (f.type === "archives" || /(^|\/)(archive|archives|archiwum)$/i.test(f.path));
}
function pasuje(k) {
  const w = (ustawienia.konto || "").trim().toLowerCase();
  if (!w || w === "*") return true;
  if (k.name.toLowerCase() === w) return true;
  return (k.identities || []).some(i => (i.email || "").toLowerCase() === w);
}

// ---------- indeks lokalny ----------
let lokalneMid = new Set();
let lokalneNiepelne = 0;
async function zbudujLokalne(konta) {
  lokalneMid = new Set();
  lokalneNiepelne = 0;
  for (const k of konta) {
    if (k.type !== "none") continue;
    for (const f of splaszcz(k.folders)) {
      try {
        for await (const m of wszystkie(f)) if (m.headerMessageId) lokalneMid.add(m.headerMessageId);
      } catch (e) {
        if (e instanceof Przerwano) throw e;   // widoki (wyszukiwania) i foldery bez bazy pomijamy
        if (e instanceof LimitCzasu) { lokalneNiepelne++; await log(`${k.name} ${f.path}: ${e.message}, pominięty`); }
      }
    }
  }
}
const jestLokalnie = mid => !!mid && lokalneMid.has(mid);

async function zapiszOczekujace() {
  for (const [mid, o] of Object.entries(oczekujace)) {
    if (lokalneMid.has(mid) || Date.now() - proba(o).t > 7 * 24 * 3600 * 1000) delete oczekujace[mid];
  }
  try { await browser.storage.local.set({ oczekujace }); } catch (e) { /* bez znaczenia */ }
}
// kopia bez potwierdzenia: nie ponawiać przez 30 min (Thunderbird może ją jeszcze zapisywać), potem ponowić
const proba = o => typeof o === "number" ? { t: o, n: 1 } : o;   // zapis ze starszych wersji: sama liczba
// po nieudanej próbie czekać 30 min (Thunderbird może jeszcze zapisywać kopię); po 3 nieudanych: 24 h
const czeka = mid => {
  const o = oczekujace[mid];
  if (!o) return false;
  const { t, n } = proba(o);
  return Date.now() - t < (n >= 3 ? 24 * 3600 * 1000 : 30 * 60 * 1000);
};
function zaznaczProbe(mid) {
  const n = (oczekujace[mid] ? proba(oczekujace[mid]).n : 0) + 1;
  oczekujace[mid] = { t: Date.now(), n };
  return n;
}
// limit czasu kopii zależny od liczby wiadomości: 2 min + 20 s na wiadomość, najwyżej 30 min
const limitKopii = n => Math.min(1800000, 120000 + 20000 * n);

// czeka (do 60 s), aż skopiowane wiadomości pojawią się w folderze docelowym; zwraca Message-ID -> id lokalne
async function potwierdzWszystkie(mids, cel) {
  const brak = new Set(mids), znalezione = new Map();
  for (let proba = 0; proba < 30 && brak.size; proba++) {
    for await (const m of wszystkie(cel)) {
      if (brak.has(m.headerMessageId)) {
        brak.delete(m.headerMessageId);
        znalezione.set(m.headerMessageId, m.id);
        lokalneMid.add(m.headerMessageId);
      }
    }
    if (brak.size) { sprawdzPrzerwanie(); await czekaj(2000); }
  }
  return znalezione;
}

// gwiazdka, etykiety i stan przeczytania kopii lokalnej jak na serwerze
async function znaczniki(oryg, lokalneId) {
  try {
    await B(browser.messages.update(lokalneId, { flagged: !!oryg.flagged, read: !!oryg.read, tags: oryg.tags || [] }), 120000, "messages.update");
  } catch (e) { /* starsze wersje: bez przenoszenia znaczników */ }
}

async function folderDocelowy(lok, typ, nadawca) {
  const wszystkieF = splaszcz(lok.folders);
  const sciezka = p => wszystkieF.find(f => f.path === p);
  if (typ === "sent") return sciezka("/Sent");
  if (typ === "drafts") return sciezka("/Drafts");
  if (typ === "templates") return sciezka("/Drafts/Szablony") || sciezka("/Drafts");
  if (typ === "archives") return sciezka("/Archives");
  const inbox = sciezka("/Inbox");
  if (!inbox) return null;
  let pod = (inbox.subFolders || []).find(f => f.name.toLowerCase() === nadawca);
  if (!pod) pod = (await B(browser.folders.getSubFolders(inbox, false), 120000, "folders.getSubFolders")).find(f => f.name.toLowerCase() === nadawca);
  if (!pod) {
    pod = await B(browser.folders.create(inbox, nadawca), 120000, "folders.create");
    inbox.subFolders = [...(inbox.subFolders || []), pod];
    await log(`  utworzono folder Odebrane/${nadawca}`);
  }
  return pod;
}
function typCelu(f) {
  if (["sent", "drafts", "templates"].includes(f.type)) return f.type;
  if (czyArchiwum(f)) return "archives";
  return "inbox";
}
const dopisz = (mapa, klucz, wartosc) => (mapa.get(klucz) || mapa.set(klucz, []).get(klucz)).push(wartosc);

// ---------- kroki ----------
// otwiera kolejno foldery w karcie poczty: Thunderbird buduje indeks folderu lokalnego,
// a folder serwera synchronizuje z serwerem (bez tego dodatek widzi stan sprzed ostatniego otwarcia)
async function otworzFoldery(lista) {
  const karty = await B(browser.mailTabs.query({}), 120000, "mailTabs.query");
  const tab = karty.find(t => t.active) || karty[0];
  if (!tab) { await log("brak karty poczty: otwórz główne okno Thunderbirda"); return 0; }
  const poprzedni = tab.displayedFolder;
  let n = 0;
  for (const f of lista) {
    sprawdzPrzerwanie();
    try {
      await B(browser.mailTabs.update(tab.id, { displayedFolder: f }), 120000, "mailTabs.update");
      let poprz = -1;
      for (let i = 0; i < 30; i++) {
        await czekaj(1000);
        const info = await B(browser.folders.getFolderInfo(f), 120000, "folders.getFolderInfo");
        if (info.totalMessageCount === poprz) break;
        poprz = info.totalMessageCount;
      }
      n++;
    } catch (e) { if (e instanceof Przerwano) throw e; /* widoki i foldery bez bazy */ }
  }
  if (poprzedni) { try { await B(browser.mailTabs.update(tab.id, { displayedFolder: poprzedni }), 120000, "mailTabs.update"); } catch (e) { /* - */ } }
  return n;
}

async function usunDuplikaty(lok) {
  let usun = 0;
  for (const f of splaszcz(lok.folders)) {
    if (czyKosz(f)) continue;
    const widziane = new Set(), nadmiar = [];
    try {
      for await (const m of wszystkie(f)) {
        if (!m.headerMessageId) continue;
        if (widziane.has(m.headerMessageId)) nadmiar.push(m.id); else widziane.add(m.headerMessageId);
      }
    } catch (e) { if (e instanceof Przerwano) throw e; continue; }
    if (nadmiar.length) { await B(browser.messages.delete(nadmiar, false), 600000, "messages.delete"); usun += nadmiar.length; }
  }
  return usun;
}

async function cyklSkrzynki(k, lok, u, licz) {
  const L = { przejrzane: 0, skopiowane: 0, juz: 0, kosz: 0, usuniete: 0, posortowane: 0, duplikaty: 0, bledy: 0 };
  const zmiany = !u.podglad;
  await log(`--- ${k.name}`);

  // 1. odbudowa indeksów lokalnych (tylko otwiera foldery: działa też w podglądzie)
  if (u.odbuduj) {
    await log(`${k.name}: odbudowa indeksów lokalnych, folderów ${await otworzFoldery(splaszcz(lok.folders))}`);
    for (const f of splaszcz(lok.folders)) {
      try { for await (const m of wszystkie(f)) if (m.headerMessageId) lokalneMid.add(m.headerMessageId); }
      catch (e) { if (e instanceof Przerwano) throw e; }
    }
  }

  // kolejność: Odebrane, inne, Archiwum, Gmail-Wszystkie; kosze osobno
  const foldery = splaszcz(k.folders).filter(f => !f.isVirtual && f.type !== "outbox");
  const kosze = foldery.filter(czyKosz);
  const waga = f => f.type === "inbox" ? 0 : czyWszystkie(f) ? 3 : czyArchiwum(f) ? 2 : 1;
  const zrodla = foldery.filter(f => !kosze.includes(f)).sort((a, b) => waga(a) - waga(b));

  // 2. odświeżenie folderów serwera (tylko otwiera foldery: działa też w podglądzie)
  if (u.odswiez) await log(`${k.name}: odświeżono foldery serwera: ${await otworzFoldery(foldery)}`);

  const serwer = new Map();   // indeks porównawczy: Message-ID -> { gwiazdka, etykiety, archiwum }
  const doKosza = new Map();  // folder -> [id oryginałów z kopią lokalną]

  // 3. kopia do lokalnych
  for (const f of zrodla) {
    sprawdzPrzerwanie();
    const grupy = new Map();
    let n = 0, bezMid = 0, wToku = 0;
    for await (const m of wszystkie(f)) {
      n++; L.przejrzane++;
      const mid = m.headerMessageId;
      if (!mid) { bezMid++; continue; }
      // Gmail: wiadomość obecna tylko w "Wszystkie" (bez Odebranych i innych etykiet) = zarchiwizowana
      const tylkoWszystkie = czyWszystkie(f) && !serwer.has(mid);
      const s = serwer.get(mid) || { gwiazdka: false, etykiety: false, archiwum: false };
      s.gwiazdka ||= !!m.flagged; s.etykiety ||= !!(m.tags && m.tags.length); s.archiwum ||= czyArchiwum(f) || tylkoWszystkie;
      serwer.set(mid, s);
      if (jestLokalnie(mid)) { L.juz++; dopisz(doKosza, f, m.id); continue; }
      if (czeka(mid)) { wToku++; continue; }
      const typ = tylkoWszystkie ? "archives" : typCelu(f);
      const nad = typ === "inbox" ? adresNadawcy(m.author) : "";
      const klucz = typ + "|" + nad;
      if (!grupy.has(klucz)) grupy.set(klucz, { typ, nad, wiad: [] });
      const g = grupy.get(klucz);
      if (!g.wiad.some(x => x.headerMessageId === mid)) g.wiad.push(m);
    }
    const doSkop = [...grupy.values()].reduce((a, g) => a + g.wiad.length, 0);
    if (n) await log(`${k.name} ${f.path}: ${n}, lokalnie ${n - doSkop - bezMid - wToku}, do skopiowania ${doSkop}` +
                     `${wToku ? ", w toku " + wToku : ""}${bezMid ? ", bez Message-ID " + bezMid : ""}`);
    if (!u.kopiuj || !zmiany) continue;
    for (const g of grupy.values()) {
      sprawdzPrzerwanie();
      try {
        const cel = await folderDocelowy(lok, g.typ, g.nad);
        if (!cel) { L.bledy++; await log(`${k.name}: brak folderu docelowego (${g.typ})`); continue; }
        const mids = g.wiad.map(m => m.headerMessageId);
        const proby = mids.map(zaznaczProbe);
        if (proby.some(n => n === 3)) await log(`${k.name} ${f.path}: ${proby.filter(n => n === 3).length} wiad. bez potwierdzonej kopii po 3 próbach: następna próba za 24 h`);
        await B(browser.messages.copy(g.wiad.map(m => m.id), cel), limitKopii(mids.length), "messages.copy");
        const ok = await potwierdzWszystkie(mids, cel);
        L.skopiowane += ok.size;
        for (const m of g.wiad) {
          if (ok.has(m.headerMessageId)) { await znaczniki(m, ok.get(m.headerMessageId)); dopisz(doKosza, f, m.id); }
        }
        if (ok.size < mids.length) await log(`${k.name} ${f.path} -> ${cel.path}: potwierdzono ${ok.size} z ${mids.length} (reszta w następnym cyklu)`);
      } catch (e) {
        if (e instanceof Przerwano) throw e;
        L.bledy++;
        await log(`${k.name} ${f.path}: BŁĄD kopiowania: ${e}`);
      }
    }
    await zapiszOczekujace();
  }

  // kosz serwera: wiadomości bez kopii lokalnej — najpierw kopia
  for (const kosz of kosze) {
    for await (const m of wszystkie(kosz)) {
      L.przejrzane++;
      const mid = m.headerMessageId;
      if (!mid) continue;
      if (!serwer.has(mid)) serwer.set(mid, { gwiazdka: !!m.flagged, etykiety: !!(m.tags && m.tags.length), archiwum: false });
      if (jestLokalnie(mid) || !u.kopiuj || !zmiany || czeka(mid)) continue;
      try {
        const cel = await folderDocelowy(lok, "inbox", adresNadawcy(m.author));
        if (zaznaczProbe(mid) === 3) await log(`${k.name} ${kosz.path}: wiad. bez potwierdzonej kopii po 3 próbach: następna próba za 24 h`);
        await B(browser.messages.copy([m.id], cel), limitKopii(1), "messages.copy");
        const ok = await potwierdzWszystkie([mid], cel);
        if (ok.size) { L.skopiowane++; await znaczniki(m, ok.get(mid)); }
      } catch (e) {
        if (e instanceof Przerwano) throw e;
        L.bledy++;
        await log(`${k.name} ${kosz.path}: BŁĄD kopiowania: ${e}`);
      }
    }
  }

  // 4. sortowanie lokalnego Odebrane
  if (u.sortuj && zmiany) {
    const lokInbox = splaszcz(lok.folders).find(f => f.path === "/Inbox");
    if (lokInbox) {
      const grupy = new Map();
      for await (const m of wszystkie(lokInbox)) dopisz(grupy, adresNadawcy(m.author), m.id);
      for (const [nad, ids] of grupy) {
        sprawdzPrzerwanie();
        try { await B(browser.messages.move(ids, await folderDocelowy(lok, "inbox", nad)), 600000, "messages.move"); L.posortowane += ids.length; }
        catch (e) { L.bledy++; await log(`${lok.name} /Inbox: BŁĄD sortowania: ${e}`); }
      }
    }
  }

  // 5. duplikaty lokalne
  if (u.duplikaty && zmiany) L.duplikaty = await usunDuplikaty(lok);

  // 6. oryginały z kopią lokalną -> kosz serwera (jawne przeniesienie; w Gmailu tylko tak trafiają do Kosza)
  if (u.kosz && zmiany) {
    for (const [f, ids] of doKosza) {
      sprawdzPrzerwanie();
      try {
        if (kosze.length) await B(browser.messages.move(ids, kosze[0]), 600000, "messages.move");
        else await B(browser.messages.delete(ids, false), 600000, "messages.delete");
        L.kosz += ids.length;
      } catch (e) {
        L.bledy++;
        await log(`${k.name} ${f.path}: BŁĄD przenoszenia do kosza: ${e}`);
      }
    }
  }

  // 7. opróżnienie koszy: serwer (tylko z kopią lokalną) i lokalny Kosz
  if (u.oproznij && zmiany) {
    for (const kosz of kosze) {
      sprawdzPrzerwanie();
      const ids = [];
      for await (const m of wszystkie(kosz)) if (jestLokalnie(m.headerMessageId)) ids.push(m.id);
      if (ids.length) {
        try { await B(browser.messages.delete(ids, true), 600000, "messages.delete"); L.usuniete += ids.length; }
        catch (e) { L.bledy++; await log(`${k.name} ${kosz.path}: BŁĄD opróżniania: ${e}`); }
      }
    }
    for (const lk of splaszcz(lok.folders).filter(czyKosz)) {
      const ids = [];
      for await (const m of wszystkie(lk)) ids.push(m.id);
      if (ids.length) {
        try { await B(browser.messages.delete(ids, true), 600000, "messages.delete"); await log(`${lok.name} ${lk.path}: opróżniono ${ids.length}`); }
        catch (e) { L.bledy++; await log(`${lok.name} ${lk.path}: BŁĄD opróżniania: ${e}`); }
      }
    }
  }
  if (!kosze.length) await log(`${k.name}: nie znaleziono folderu kosza`);

  // indeks porównawczy serwer <-> lokalnie
  let lokalnie = 0, gw = 0, et = 0, ar = 0;
  for (const [mid, s] of serwer) {
    if (jestLokalnie(mid)) lokalnie++;
    if (s.gwiazdka) gw++;
    if (s.etykiety) et++;
    if (s.archiwum) ar++;
  }
  indeks[k.name] = { czas: czas(), unikalnych: serwer.size, lokalnie, brakuje: serwer.size - lokalnie, gwiazdki: gw, etykiety: et, archiwum: ar };
  await log(`${k.name}: na serwerze ${serwer.size} (gwiazdka ${gw}, etykiety ${et}, archiwum ${ar}), z kopią lokalną ${lokalnie}, ` +
            `bez kopii ${serwer.size - lokalnie} | skopiowane ${L.skopiowane}, posortowane ${L.posortowane}, duplikaty ${L.duplikaty}, ` +
            `do kosza ${L.kosz}, usunięte z kosza ${L.usuniete}, błędy ${L.bledy}`);
  for (const x of Object.keys(L)) licz[x] = (licz[x] || 0) + L[x];
}

// ---------- cykl ----------
async function cykl(powod) {
  if (pracuje) { await log(`pominięto (${powod}): poprzedni cykl trwa`); return; }
  pracuje = true;
  przerwij = false;
  nowePrzerwanie();
  const u = { ...ustawienia };
  const licz = {};
  try {
    const opis = (u.podglad ? "PODGLĄD + " : "") + KROKI.filter(x => u[x]).join("+");
    await log(`=== cykl (${powod}): ${opis || "brak kroków"}; skrzynka: ${u.konto && u.konto !== "*" ? u.konto : "wszystkie"}`);
    const konta = await B(browser.accounts.list(true), 120000, "accounts.list");
    const lokalne = new Map();
    for (const k of konta) if (k.type === "none" && k.name.endsWith(" - lokalne")) lokalne.set(k.name.slice(0, -10).toLowerCase(), k);
    await zbudujLokalne(konta);
    await log(`wiadomości w kontach lokalnych: ${lokalneMid.size}`);
    if (lokalneNiepelne && u.kopiuj) {
      u.kopiuj = false;
      await log(`indeks lokalny niepełny (folderów bez odpowiedzi: ${lokalneNiepelne}): kopiowanie wyłączone w tym cyklu, żeby nie robić duplikatów`);
    }
    const wybrane = konta.filter(k => k.type === "imap" && pasuje(k));
    if (!wybrane.length) await log(`brak skrzynki "${u.konto}"`);
    for (const k of wybrane) {
      sprawdzPrzerwanie();
      const lok = lokalne.get(k.name.toLowerCase());
      if (!lok) { await log(`${k.name}: brak konta lokalnego, pominięta`); continue; }
      try { await cyklSkrzynki(k, lok, u, licz); }
      catch (e) {
        if (e instanceof Przerwano) throw e;
        licz.bledy = (licz.bledy || 0) + 1;
        await log(`${k.name}: BŁĄD cyklu: ${e}`);
      }
    }
  } catch (e) {
    if (e instanceof Przerwano) await log("przerwano na żądanie");
    else { licz.bledy = (licz.bledy || 0) + 1; await log(`BŁĄD cyklu: ${e}`); }
  } finally {
    pracuje = false;
    przerwij = false;
    await zapiszOczekujace();
    if (u.podglad) await log("(podgląd: nic nie zmieniono)");
    await log(`=== koniec cyklu: przejrzane ${licz.przejrzane || 0}, skopiowane ${licz.skopiowane || 0}, posortowane ${licz.posortowane || 0}, ` +
              `duplikaty ${licz.duplikaty || 0}, do kosza ${licz.kosz || 0}, usunięte z kosza ${licz.usuniete || 0}, błędy ${licz.bledy || 0}`);
    try { await browser.storage.local.set({ dziennik, indeks }); } catch (e) { /* - */ }
  }
}

// ---------- uruchamianie ----------
let zegar = null;
function ustawZegar() {
  if (zegar) clearInterval(zegar);
  zegar = null;
  if (ustawienia.autoCo) {
    const min = Math.max(5, Number(ustawienia.interwal) || DOMYSLNE.interwal);
    zegar = setInterval(() => cykl("co " + min + " min"), min * 60 * 1000);
  }
}
async function start() {
  const zap = await browser.storage.local.get(["ustawienia", "dziennik", "oczekujace", "indeks"]);
  ustawienia = { ...DOMYSLNE, ...(zap.ustawienia || {}) };
  dziennik = zap.dziennik || [];
  oczekujace = zap.oczekujace || {};
  indeks = zap.indeks || {};
  await log(`start ${browser.runtime.getManifest().version}`);
  ustawZegar();
  if (ustawienia.autoStart) setTimeout(() => cykl("po starcie"), 3 * 60 * 1000);   // po synchronizacji IMAP przy starcie
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.co === "ustawienia" || msg.co === "cykl") {
    if (msg.ustawienia) {
      ustawienia = { ...DOMYSLNE, ...msg.ustawienia };
      await browser.storage.local.set({ ustawienia });
      ustawZegar();
    }
    if (msg.co === "cykl") {
      const uruchomiono = !pracuje;
      cykl("ręcznie");
      return { uruchomiono };
    }
    return true;
  }
  if (msg.co === "przerwij") {
    const pracowal = pracuje;
    if (pracuje) { przerwij = true; przerwanie.odrzuc(new Przerwano()); await log("żądanie przerwania"); }
    return { pracowal };
  }
  if (msg.co === "stan") return { pracuje, ustawienia, wersja: browser.runtime.getManifest().version, indeks };
  if (msg.co === "konta") {
    const konta = await browser.accounts.list(false);
    return konta.filter(k => k.type === "imap").map(k => k.name);
  }
  if (msg.co === "dziennik") return dziennik.join("\n");
  if (msg.co === "wyczysc") { dziennik = []; await browser.storage.local.set({ dziennik }); return true; }
});

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());
start();
