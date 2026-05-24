/* ══════════════════════════════════════════
   SOUNDVAULT v2 — app.js
   API: Deezer (via corsproxy.io) + iTunes (charts fallback)
   Storage: localStorage — canzoni + artisti separati
   ══════════════════════════════════════════ */
'use strict';

// ─── CONFIG ─────────────────────────────────
const DEEZER  = 'https://api.deezer.com';
const ITUNES  = 'https://itunes.apple.com';
const LASTFM  = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_KEY = '0f1b930bfe7a13cb238ab80e8eef4e34';
const PROXY   = 'https://api.allorigins.win/raw?url=';
const STORAGE = 'soundvault_v2';

// ─── STATE ──────────────────────────────────
let searchMode   = 'songs';   // 'songs' | 'artists'
let favTab       = 'songs';   // 'songs' | 'artists'
let lastResults  = [];        // cache risultati ricerca
let chartsLoaded = false;
let currentAudio = null;
let currentCard  = null;      // <article> del brano in play
let progressTimer = null;

// ─── FAVORITES ──────────────────────────────
let favs = loadFavs();

function loadFavs() {
  try {
    const raw = localStorage.getItem(STORAGE);
    const data = raw ? JSON.parse(raw) : {};
    return { songs: data.songs || [], artists: data.artists || [] };
  } catch { return { songs: [], artists: [] }; }
}
function saveFavs() {
  try { localStorage.setItem(STORAGE, JSON.stringify(favs)); } catch(e) {}
}

// ─── DOM ────────────────────────────────────
const $ = id => document.getElementById(id);
const navBtns        = document.querySelectorAll('.nav-btn');
const modeBtns       = document.querySelectorAll('.mode-btn');
const favTabBtns     = document.querySelectorAll('.fav-tab');
const searchInputEl  = $('searchInput');
const searchBtnEl    = $('searchBtn');
const searchResultsEl= $('searchResults');
const searchLoaderEl = $('searchLoader');
const searchEmptyEl  = $('searchEmpty');
const searchPlaceholder = $('searchPlaceholder');
const searchViewEl   = $('searchView');
const artistDetailViewEl = $('artistDetailView');
const artistHeroEl   = $('artistHero');
const artistTracksSectionEl = $('artistTracksSection');
const artistAlbumsSectionEl = $('artistAlbumsSection');
const artistDetailLoaderEl = $('artistDetailLoader');
const backBtnEl      = $('backBtn');
const chartsResultsEl= $('chartsResults');
const chartsLoaderEl = $('chartsLoader');
const favSongsGridEl = $('favSongsGrid');
const favSongsEmptyEl= $('favSongsEmpty');
const favArtistsGridEl = $('favArtistsGrid');
const favArtistsEmptyEl= $('favArtistsEmpty');
const favSongsViewEl = $('favSongsView');
const favArtistsViewEl = $('favArtistsView');
const favCountEl     = $('favCount');
const songFavCountEl = $('songFavCount');
const artistFavCountEl = $('artistFavCount');
const toastEl        = $('toast');
const nowPlayingEl   = $('nowPlaying');
const npStopEl       = $('npStop');

// ─── NAVIGAZIONE PRINCIPALE ─────────────────
const sections = {
  search:    $('sectionSearch'),
  charts:    $('sectionCharts'),
  favorites: $('sectionFavorites'),
};

navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.section;
    navBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.entries(sections).forEach(([k, el]) => {
      el.classList.toggle('hidden', k !== target);
      el.classList.toggle('active', k === target);
    });
    if (target === 'favorites') renderFavorites();
    if (target === 'charts' && !chartsLoaded) loadCharts();
  });
});

// ─── TOGGLE MODALITÀ RICERCA ─────────────────
modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    searchMode = btn.dataset.mode;
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // aggiorna placeholder
    searchInputEl.placeholder = searchMode === 'songs'
      ? 'Cerca canzoni… es. Bohemian Rhapsody'
      : 'Cerca artisti… es. Vasco Rossi';
  });
});

// ─── RICERCA ────────────────────────────────
searchBtnEl.addEventListener('click', doSearch);
searchInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const q = searchInputEl.value.trim();
  if (!q) return;
  showSearchView();
  searchResultsEl.innerHTML = '';
  searchEmptyEl.classList.add('hidden');
  searchPlaceholder.classList.add('hidden');
  show(searchLoaderEl);

  try {
    if (searchMode === 'songs') {
      const data = await fetchDeezer(`/search?q=${enc(q)}&limit=40`);
      lastResults = data.data || [];
      if (!lastResults.length) { searchEmptyEl.classList.remove('hidden'); return; }
      renderSongCards(lastResults, searchResultsEl);
    } else {
      // Usa Deezer per artisti con timeout breve, poi fallback iTunes
      let found = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`${PROXY}${enc(`${DEEZER}/search?q=${enc(q)}&limit=40`)}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          lastResults = (data.data || []).filter(item => item.type === 'artist');
          if (lastResults.length) found = true;
        }
      } catch (e) {
        // Fallback
      }
      
      if (!found) {
        // Fallback iTunes
        try {
          const data = await fetchJSON(`${ITUNES}/search?term=${enc(q)}&entity=musicArtist&limit=40`);
          lastResults = (data.results || []).map(artist => ({
            id: artist.artistId,
            name: artist.artistName,
            picture_medium: artist.artworkUrl100 || '',
            picture_big: artist.artworkUrl100 || '',
            nb_fan: 0,
            nb_album: 0,
            link: artist.artistLinkUrl || '',
            type: 'artist'
          }));
        } catch { }
      }
      
      if (!lastResults.length) { searchEmptyEl.classList.remove('hidden'); return; }
      renderArtistCards(lastResults, searchResultsEl);
    }
  } catch (err) {
    console.error(err);
    // Fallback iTunes per canzoni
    if (searchMode === 'songs') {
      try {
        const data = await fetchJSON(`${ITUNES}/search?term=${enc(q)}&entity=song&limit=40`);
        const songs = (data.results || []).map(itunesTrackToDeezer);
        if (!songs.length) { searchEmptyEl.classList.remove('hidden'); return; }
        renderSongCards(songs, searchResultsEl);
      } catch { showToast('Errore di rete. Riprova.'); }
    } else {
      showToast('Errore caricamento artisti. Riprova.');
    }
  } finally {
    hide(searchLoaderEl);
  }
}

// ─── TOP CHARTS ──────────────────────────────
async function loadCharts() {
  show(chartsLoaderEl);
  try {
    const data = await fetchDeezer('/chart/0/tracks?limit=25');
    const tracks = (data.tracks?.data || []).map((t, i) => ({ ...t, _rank: i + 1 }));
    renderSongCards(tracks, chartsResultsEl, true);
    chartsLoaded = true;
  } catch {
    // Fallback iTunes charts
    try {
      const url = `${PROXY}${enc('https://itunes.apple.com/it/rss/topsongs/limit=25/json')}`;
      const data = await fetchJSON(url);
      const songs = (data?.feed?.entry || []).map((item, i) => ({
        id: item.id?.attributes?.['im:id'] || i,
        title: item['im:name']?.label || '',
        artist: { name: item['im:artist']?.label || '' },
        album: { cover_medium: item['im:image']?.[2]?.label || '', title: '' },
        preview: '',
        link: item.link?.attributes?.href || '#',
        _rank: i + 1,
      }));
      renderSongCards(songs, chartsResultsEl, true);
      chartsLoaded = true;
    } catch {
      chartsResultsEl.innerHTML = '<p style="padding:40px;text-align:center;color:var(--cream-dim)">Impossibile caricare le charts.</p>';
    }
  } finally {
    hide(chartsLoaderEl);
  }
}

// ─── ARTIST DETAIL ───────────────────────────
async function openArtistDetail(artistId, artistName) {
  showDetailView();
  artistHeroEl.innerHTML = '';
  artistTracksSectionEl.innerHTML = '';
  artistAlbumsSectionEl.innerHTML = '';
  show(artistDetailLoaderEl);

  try {
    let artist = null;
    let tracks = [];
    let albums = [];
    
    // Prova a caricare i dati con timeout
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const artistRes = await fetch(`${PROXY}${enc(`${DEEZER}/artist/${artistId}`)}`, { signal: controller.signal });
      const tracksRes = await fetch(`${PROXY}${enc(`${DEEZER}/artist/${artistId}/top?limit=20`)}`, { signal: controller.signal });
      const albumsRes = await fetch(`${PROXY}${enc(`${DEEZER}/artist/${artistId}/albums?limit=20`)}`, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (artistRes.ok && tracksRes.ok) {
        artist = await artistRes.json();
        const tracksData = await tracksRes.json();
        tracks = tracksData.data || [];
        
        if (albumsRes.ok) {
          const albumsData = await albumsRes.json();
          albums = albumsData.data || [];
        }
      }
    } catch (e) {
      // Fallback: prova a cercare l'artista per nome su Deezer
      if (artistName) {
        try {
          const searchRes = await fetchJSON(`${ITUNES}/search?term=${enc(artistName)}&entity=musicArtist&limit=1`);
          const artistData = searchRes.results?.[0];
          if (artistData) {
            artist = {
              id: artistData.artistId,
              name: artistData.artistName,
              picture_big: artistData.artworkUrl100 || '',
              picture_medium: artistData.artworkUrl100 || '',
              nb_fan: 0,
              nb_album: 0,
              link: artistData.artistLinkUrl || ''
            };
          }
        } catch { }
      }
    }
    
    if (!artist) throw new Error('Artista non trovato');
    
    renderArtistHero(artist);
    if (tracks.length) {
      artistTracksSectionEl.innerHTML = `<h3 class="artist-tracks-heading">Top Brani</h3>`;
      const grid = document.createElement('div');
      grid.className = 'results-grid';
      artistTracksSectionEl.appendChild(grid);
      renderSongCards(tracks, grid);
    }
    
    if (albums.length) {
      renderArtistAlbums(albums);
    }
  } catch(err) {
    console.error(err);
    artistHeroEl.innerHTML = '<p style="color:var(--cream-dim);padding:20px">Impossibile caricare i dettagli artista.</p>';
  } finally {
    hide(artistDetailLoaderEl);
  }
}

function renderArtistHero(artist) {
  const isFav = isArtistFav(artist.id);
  const picUrl = artist.picture_big || artist.picture_medium || '';
  const initials = getInitials(artist.name);

  artistHeroEl.innerHTML = `
    <div class="artist-hero">
      <div class="artist-hero-img">
        ${picUrl
          ? `<img src="${picUrl}" alt="${esc(artist.name)}" />`
          : `<div class="artist-hero-img-placeholder">${initials}</div>`}
      </div>
      <div class="artist-hero-info">
        <div class="artist-hero-type">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${artist.nb_album > 0 ? 'Artista musicale' : 'Artista'}
        </div>
        <h1 class="artist-hero-name">${esc(artist.name)}</h1>
        <div class="artist-hero-stats">
          ${artist.nb_fan ? `
            <div class="stat-chip">
              <div class="stat-chip-value">${formatNum(artist.nb_fan)}</div>
              <div class="stat-chip-label">Fan</div>
            </div>` : ''}
          ${artist.nb_album ? `
            <div class="stat-chip">
              <div class="stat-chip-value">${artist.nb_album}</div>
              <div class="stat-chip-label">Album</div>
            </div>` : ''}
          ${artist.radio ? `
            <div class="stat-chip">
              <div class="stat-chip-value">✓</div>
              <div class="stat-chip-label">Radio</div>
            </div>` : ''}
        </div>
        <div class="artist-hero-actions">
          <button class="hero-fav-btn ${isFav ? 'active' : ''}" id="heroFavBtn" data-id="${artist.id}">
            <svg viewBox="0 0 24 24" stroke-width="1.8">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            ${isFav ? 'Nei preferiti' : 'Aggiungi ai preferiti'}
          </button>
          ${artist.link ? `
            <a class="hero-link-btn" href="${artist.link}" target="_blank" rel="noopener">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Su Deezer
            </a>` : ''}
        </div>
      </div>
    </div>
  `;

  $('heroFavBtn').addEventListener('click', () => toggleArtistFav(artist, $('heroFavBtn')));
}

function renderArtistAlbums(albums) {
  artistAlbumsSectionEl.innerHTML = `<h3 class="artist-albums-heading">Album</h3>`;
  const grid = document.createElement('div');
  grid.className = 'results-grid';
  artistAlbumsSectionEl.appendChild(grid);

  albums.forEach((album, i) => {
    const art = album.cover_medium || '';
    const releaseYear = album.release_date ? album.release_date.split('-')[0] : '';
    const card = document.createElement('article');
    card.className = 'album-card';
    card.style.animationDelay = `${Math.min(i * 35, 450)}ms`;

    card.innerHTML = `
      <div class="card-art">
        ${art
          ? `<img src="${esc(art)}" alt="${esc(album.title)}" loading="lazy" />`
          : `<div class="card-art-placeholder">💿</div>`}
      </div>
      <div class="card-body">
        <div class="card-track" title="${esc(album.title)}">${esc(album.title)}</div>
        ${releaseYear ? `<div class="album-release-year">${releaseYear}</div>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

// ─── RENDER SONG CARDS ───────────────────────
function renderSongCards(songs, container, showRank = false) {
  container.innerHTML = '';
  songs.forEach((song, i) => {
    const isFav   = isSongFav(song.id);
    const art     = song.album?.cover_medium || song.artworkUrl100 || '';
    const preview = song.preview || '';
    const card    = document.createElement('article');
    card.className = 'song-card';
    card.style.animationDelay = `${Math.min(i * 35, 450)}ms`;
    card.dataset.id = song.id;

    card.innerHTML = `
      <div class="card-art">
        ${art
          ? `<img src="${esc(art)}" alt="${esc(song.title)}" loading="lazy" />`
          : `<div class="card-art-placeholder">♪</div>`}
        ${showRank && song._rank ? `<div class="card-rank">#${song._rank}</div>` : ''}
        ${preview ? `
          <button class="card-play-btn" title="Ascolta anteprima" aria-label="Ascolta anteprima">
            <svg class="play-icon" viewBox="0 0 24 24" width="14" height="14"><polygon points="5,3 19,12 5,21"/></svg>
            <svg class="pause-icon" viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          </button>` : ''}
      </div>
      <div class="card-body">
        <div class="card-track">${esc(song.title)}</div>
        <div class="card-artist">${esc(song.artist?.name || '')}</div>
        ${song.album?.title ? `<div class="card-meta">${esc(song.album.title)}</div>` : ''}
        <div class="card-footer">
          <span class="card-genre">${esc(song.genre_name || song.primaryGenreName || '—')}</span>
          <button class="fav-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Rimuovi' : 'Aggiungi ai preferiti'}">
            <svg viewBox="0 0 24 24" stroke-width="1.8">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Preview audio
    if (preview) {
      card.querySelector('.card-play-btn').addEventListener('click', e => {
        e.stopPropagation();
        playPreview(preview, card, song);
      });
    }

    // Fav
    card.querySelector('.fav-btn').addEventListener('click', () => toggleSongFav(song, card.querySelector('.fav-btn')));

    container.appendChild(card);
  });
}

// ─── RENDER ARTIST CARDS ─────────────────────
function renderArtistCards(artists, container) {
  container.innerHTML = '';
  artists.forEach((artist, i) => {
    const isFav = isArtistFav(artist.id);
    const pic   = artist.picture_medium || '';
    const initials = getInitials(artist.name);
    const card  = document.createElement('article');
    card.className = 'artist-card';
    card.style.animationDelay = `${Math.min(i * 35, 450)}ms`;

    card.innerHTML = `
      <div class="artist-card-img">
        ${pic
          ? `<img src="${esc(pic)}" alt="${esc(artist.name)}" loading="lazy" />`
          : `<div class="artist-card-img-placeholder">${initials}</div>`}
      </div>
      <div class="artist-card-overlay">
        <div class="artist-card-info">
          <div class="artist-name-card">${esc(artist.name)}</div>
          <div class="artist-stats-row">
            ${artist.nb_fan ? `
              <div class="artist-stat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                ${formatNum(artist.nb_fan)}
              </div>` : ''}
            ${artist.nb_album ? `
              <div class="artist-stat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
                ${artist.nb_album} album
              </div>` : ''}
          </div>
        </div>
      </div>
      <button class="artist-card-fav ${isFav ? 'active' : ''}" title="${isFav ? 'Rimuovi' : 'Aggiungi ai preferiti'}">
        <svg viewBox="0 0 24 24" stroke-width="1.8">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </button>
      <button class="artist-card-view-btn">Esplora →</button>
    `;

    card.querySelector('.artist-card-fav').addEventListener('click', e => {
      e.stopPropagation();
      toggleArtistFav(artist, card.querySelector('.artist-card-fav'));
    });
    card.querySelector('.artist-card-view-btn').addEventListener('click', e => {
      e.stopPropagation();
      openArtistDetail(artist.id, artist.name);
    });
    card.addEventListener('click', () => openArtistDetail(artist.id, artist.name));

    container.appendChild(card);
  });
}

// ─── FAVORITES RENDER ────────────────────────
function renderFavorites() {
  updateFavCounts();
  if (favTab === 'songs') renderFavSongs();
  else renderFavArtists();
}

function renderFavSongs() {
  if (!favs.songs.length) {
    favSongsGridEl.innerHTML = '';
    favSongsEmptyEl.classList.remove('hidden');
    return;
  }
  favSongsEmptyEl.classList.add('hidden');
  renderSongCards(favs.songs, favSongsGridEl);
}

function renderFavArtists() {
  if (!favs.artists.length) {
    favArtistsGridEl.innerHTML = '';
    favArtistsEmptyEl.classList.remove('hidden');
    return;
  }
  favArtistsEmptyEl.classList.add('hidden');
  renderArtistCards(favs.artists, favArtistsGridEl);
}

// ─── TAB PREFERITI ───────────────────────────
favTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    favTab = btn.dataset.favtab;
    favTabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    favSongsViewEl.classList.toggle('hidden', favTab !== 'songs');
    favArtistsViewEl.classList.toggle('hidden', favTab !== 'artists');
    renderFavorites();
  });
});

// ─── TOGGLE FAV CANZONI ──────────────────────
function toggleSongFav(song, btn) {
  const id  = String(song.id);
  const was = isSongFav(id);
  if (was) {
    favs.songs = favs.songs.filter(s => String(s.id) !== id);
    showToast(`Rimosso: ${song.title}`);
  } else {
    favs.songs.push(song);
    showToast(`❤ Aggiunto: ${song.title}`, 'add');
  }
  saveFavs(); updateFavCounts();
  // aggiorna tutti i bottoni con stesso id
  document.querySelectorAll(`.fav-btn`).forEach(b => {
    if (b.closest('[data-id="' + id + '"]')) b.classList.toggle('active', !was);
  });
  btn.classList.toggle('active', !was);
  bumpCount();
}

// ─── TOGGLE FAV ARTISTI ──────────────────────
function toggleArtistFav(artist, btn) {
  const id  = String(artist.id);
  const was = isArtistFav(id);
  if (was) {
    favs.artists = favs.artists.filter(a => String(a.id) !== id);
    showToast(`Rimosso: ${artist.name}`);
  } else {
    favs.artists.push(artist);
    showToast(`❤ Aggiunto: ${artist.name}`, 'add');
  }
  saveFavs(); updateFavCounts();
  // aggiorna tutti i bottoni artista con stesso id
  document.querySelectorAll('.artist-card-fav, .hero-fav-btn').forEach(b => {
    if (b.dataset.id === id || b.closest('.artist-card')?.dataset?.id === id) {
      b.classList.toggle('active', !was);
      if (b.classList.contains('hero-fav-btn')) {
        b.textContent = '';
        b.innerHTML = `<svg viewBox="0 0 24 24" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${!was ? 'Nei preferiti' : 'Aggiungi ai preferiti'}`;
      }
    }
  });
  btn.classList.toggle('active', !was);
  bumpCount();
}

function isSongFav(id) { return favs.songs.some(s => String(s.id) === String(id)); }
function isArtistFav(id) { return favs.artists.some(a => String(a.id) === String(id)); }

function updateFavCounts() {
  const total = favs.songs.length + favs.artists.length;
  favCountEl.textContent = total;
  favCountEl.style.display = total > 0 ? 'inline-flex' : 'none';
  songFavCountEl.textContent = favs.songs.length;
  artistFavCountEl.textContent = favs.artists.length;
}

function bumpCount() {
  favCountEl.classList.add('bump');
  setTimeout(() => favCountEl.classList.remove('bump'), 300);
}

// ─── BACK BUTTON ─────────────────────────────
backBtnEl.addEventListener('click', showSearchView);

function showSearchView() {
  searchViewEl.classList.remove('hidden');
  artistDetailViewEl.classList.add('hidden');
  if (!lastResults.length) searchPlaceholder.classList.remove('hidden');
}

function showDetailView() {
  searchViewEl.classList.add('hidden');
  artistDetailViewEl.classList.remove('hidden');
}

// ─── AUDIO PREVIEW ───────────────────────────
npStopEl.addEventListener('click', stopAudio);

function playPreview(url, card, song) {
  // Se stesso brano → stop
  if (currentCard === card && currentAudio) {
    stopAudio(); return;
  }
  // Ferma precedente
  stopAudio(false);

  currentAudio = new Audio(url);
  currentAudio.volume = 0.75;
  currentCard  = card;
  card.classList.add('playing');

  // Now playing bar
  nowPlayingEl.classList.remove('hidden');
  nowPlayingEl.querySelector('.np-title').textContent = song.title;
  nowPlayingEl.querySelector('.np-artist').textContent = song.artist?.name || '';
  const npArt = nowPlayingEl.querySelector('.np-art');
  const artSrc = song.album?.cover_medium || '';
  npArt.innerHTML = artSrc ? `<img src="${artSrc}" />` : '';

  const fillEl = nowPlayingEl.querySelector('.np-fill');
  const timeEl = nowPlayingEl.querySelector('.np-time');

  currentAudio.addEventListener('timeupdate', () => {
    const pct = (currentAudio.currentTime / 30) * 100;
    fillEl.style.width = Math.min(pct, 100) + '%';
    timeEl.textContent = fmtTime(currentAudio.currentTime);
  });
  currentAudio.addEventListener('ended', () => stopAudio());

  currentAudio.play().catch(() => {
    showToast('Anteprima non disponibile per questo brano.');
    stopAudio();
  });
}

function stopAudio(hideBar = true) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (currentCard)  { currentCard.classList.remove('playing'); currentCard = null; }
  if (hideBar) nowPlayingEl.classList.add('hidden');
  nowPlayingEl.querySelector('.np-fill').style.width = '0%';
  nowPlayingEl.querySelector('.np-time').textContent = '0:00';
}

// ─── API HELPERS ─────────────────────────────
async function fetchDeezer(path) {
  const url = `${PROXY}${DEEZER}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Fetch artisti da Last.fm
async function fetchLastFmArtists(query) {
  const url = `${LASTFM}?method=artist.search&artist=${enc(query)}&api_key=${LASTFM_KEY}&format=json&limit=24`;
  const proxyUrl = `${PROXY}${url}`;
  try {
    const data = await fetchJSON(proxyUrl);
    console.log('Last.fm response:', data);
    const artists = (data.results?.artistmatches?.artist || []).map(lastFmArtistToDeezer);
    console.log('Converted artists:', artists);
    return artists;
  } catch (err) {
    console.error('Last.fm error:', err);
    throw err;
  }
}

// Converti artista Last.fm in formato Deezer-like
function lastFmArtistToDeezer(artist) {
  const images = artist.image || [];
  let bigImage = images.find(img => img.size === 'extralarge')?.['#text'] || 
                 images.find(img => img.size === 'large')?.['#text'] ||
                 images.find(img => img.size === 'medium')?.['#text'] || '';
  
  // Passa le immagini attraverso il PROXY per CORS
  if (bigImage && bigImage.startsWith('http')) {
    bigImage = `${PROXY}${bigImage}`;
  }
  
  const listeners = parseInt(artist.listeners) || 0;
  console.log(`Artist ${artist.name}: image=${bigImage}, listeners=${listeners}`);
  
  return {
    id: artist.mbid || artist.name.replace(/\s+/g, '_'),
    name: artist.name || '',
    picture_medium: bigImage,
    picture_big: bigImage,
    nb_fan: listeners,
    nb_album: 0,
    link: artist.url || '',
  };
}

// Converti traccia iTunes in formato Deezer-like
function itunesTrackToDeezer(t) {
  return {
    id: t.trackId,
    title: t.trackName,
    artist: { name: t.artistName },
    album: { title: t.collectionName || '', cover_medium: (t.artworkUrl100 || '').replace('100x100', '300x300') },
    preview: t.previewUrl || '',
    link: t.trackViewUrl || '',
    primaryGenreName: t.primaryGenreName || '',
  };
}

// ─── TOAST ───────────────────────────────────
let toastTimer = null;
function showToast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast show${type ? ' type-' + type : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ─── UTILITY ─────────────────────────────────
function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return Math.round(n / 1_000) + 'K';
  return String(n);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function getInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function enc(str) { return encodeURIComponent(str); }
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ─── INIT ────────────────────────────────────
(function init() {
  updateFavCounts();

  // Placeholder rotante nell'input
  const hints = ['Es. Bohemian Rhapsody…', 'Es. Vasco Rossi…', 'Es. Daft Punk…', 'Es. Lucio Battisti…', 'Es. Billie Eilish…'];
  let hi = 0;
  setInterval(() => {
    if (document.activeElement !== searchInputEl) {
      searchInputEl.setAttribute('placeholder', hints[hi++ % hints.length]);
    }
  }, 3000);
})();