'use strict';

/* =====================================================================
   CONFIG
   ===================================================================== */
const CONFIG = {
    // TODO: replace with the raw.githubusercontent.com URL to YOUR data repo.
    // Format: https://raw.githubusercontent.com/<user>/<repo>/<branch>/<path>
    // The repo must be PUBLIC — raw.githubusercontent.com can't serve a
    // private repo's files without an auth token, and embedding a token in
    // client-side JS would expose it to every visitor.
    DATABASE_URL: 'https://raw.githubusercontent.com/idonotworkeveryday/Sunnah-database/refs/heads/main/database.json'
};

/* =====================================================================
   UTILS
   ===================================================================== */
const Utils = {
    // Escapes text for safe use in either HTML text content or attribute
    // values (attribute contexts need quotes escaped too, which a
    // textContent round-trip alone would not do).
    escapeHtml(str) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(str ?? '').replace(/[&<>"']/g, ch => map[ch]);
    },

    // Strip diacritics and normalize letterform variants so Arabic search
    // matches regardless of the exact tashkeel or alif form typed in.
    normalizeArabic(str) {
        if (!str) return '';
        return str
            .replace(/[\u064B-\u0652]/g, '')
            .replace(/[أإآا]/g, 'ا')
            .replace(/ة/g, 'ه')
            .replace(/ى/g, 'ي');
    },

    debounce(fn, waitMs) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), waitMs);
        };
    },

    // Escapes text, then wraps case-insensitive matches of `query` in <mark>.
    // Escaping first means the result is always safe to inject as HTML.
    highlight(text, query) {
        const safe = Utils.escapeHtml(text);
        if (!query) return safe;
        const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        return safe.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark>$1</mark>');
    }
};

/* =====================================================================
   STORE — single source of truth for application state and navigation
   ===================================================================== */
const Store = {
    state: {
        all: [],
        status: 'loading',      // 'loading' | 'ready' | 'error'
        view: 'collections',    // 'collections' | 'chapters' | 'list' | 'search'
        activeCollection: null,
        activeChapter: null,
        query: '',
        displayLimit: 10
    },

    _returnView: null,
    _returnCollection: null,
    _returnChapter: null,

    async load(attempt = 1) {
        const maxAttempts = 3;
        try {
            const bustedUrl = `${CONFIG.DATABASE_URL}${CONFIG.DATABASE_URL.includes('?') ? '&' : '?'}t=${Date.now()}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            const response = await fetch(bustedUrl, { cache: 'no-store', signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.state.all = await response.json();
            this.state.status = 'ready';
        } catch (err) {
            console.error(`Database load attempt ${attempt}/${maxAttempts} failed:`, err);
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, attempt * 700));
                return this.load(attempt + 1);
            }
            this.state.status = 'error';
        }
    },

    /* ---- grouping / querying helpers ---- */
    collections() {
        const counts = new Map();
        for (const h of this.state.all) counts.set(h.book, (counts.get(h.book) || 0) + 1);
        return [...counts.entries()].map(([name, count]) => ({ name, count }));
    },

    chaptersOf(book) {
        const counts = new Map();
        for (const h of this.state.all) {
            if (h.book !== book) continue;
            counts.set(h.chapter, (counts.get(h.chapter) || 0) + 1);
        }
        return [...counts.entries()].map(([name, count]) => ({ name, count }));
    },

    hadithsOf(book, chapter) {
        return this.state.all.filter(h => h.book === book && h.chapter === chapter);
    },

    searchResults(query) {
        const q = query.toLowerCase();
        const qArabic = Utils.normalizeArabic(query);
        return this.state.all.filter(item =>
            item.english.toLowerCase().includes(q) ||
            Utils.normalizeArabic(item.arabic).includes(qArabic) ||
            item.chapter.toLowerCase().includes(q) ||
            item.book.toLowerCase().includes(q) ||
            item.explanation.toLowerCase().includes(q) ||
            String(item.number).includes(q)
        );
    },

    currentList() {
        if (this.state.view === 'list') return this.hadithsOf(this.state.activeCollection, this.state.activeChapter);
        if (this.state.view === 'search') return this.searchResults(this.state.query);
        return [];
    },

    visibleItems() {
        return this.currentList().slice(0, this.state.displayLimit);
    },

    hasMore() {
        return this.currentList().length > this.state.displayLimit;
    },

    /* ---- navigation ---- */
    goToCollections() {
        this.state.view = 'collections';
        this.state.activeCollection = null;
        this.state.activeChapter = null;
        this.state.displayLimit = 10;
    },

    goToCollection(book) {
        this.state.view = 'chapters';
        this.state.activeCollection = book;
        this.state.activeChapter = null;
        this.state.displayLimit = 10;
    },

    goToChapter(book, chapter) {
        this.state.view = 'list';
        this.state.activeCollection = book;
        this.state.activeChapter = chapter;
        this.state.displayLimit = 10;
    },

    loadMore() {
        this.state.displayLimit += 10;
    },

    // Search overrides whatever browsing view is active. Clearing the
    // query restores exactly where the person was before they searched.
    setQuery(rawQuery) {
        const q = rawQuery.trim();
        if (q && this.state.view !== 'search') {
            this._returnView = this.state.view;
            this._returnCollection = this.state.activeCollection;
            this._returnChapter = this.state.activeChapter;
        }

        this.state.query = q;
        this.state.displayLimit = 10;

        if (q) {
            this.state.view = 'search';
        } else if (this._returnView) {
            this.state.view = this._returnView;
            this.state.activeCollection = this._returnCollection;
            this.state.activeChapter = this._returnChapter;
        } else {
            this.state.view = 'collections';
        }
    }
};

/* =====================================================================
   TEMPLATES — pure string builders, no DOM access
   ===================================================================== */
const Templates = {
    navCard({ role, book, chapter, title, meta, size = 'md' }) {
        const attrs = [`data-role="${role}"`, `data-book="${Utils.escapeHtml(book)}"`];
        if (chapter !== undefined) attrs.push(`data-chapter="${Utils.escapeHtml(chapter)}"`);
        const titleSize = size === 'lg' ? 'text-[17px]' : 'text-[15px]';
        return `
            <button type="button" ${attrs.join(' ')} class="nav-card">
                <span class="nav-card-title ${titleSize}">${Utils.escapeHtml(title)}</span>
                <span class="flex items-center gap-3 shrink-0">
                    <span class="nav-card-meta">${meta}</span>
                    <span class="nav-card-chevron" aria-hidden="true">→</span>
                </span>
            </button>`;
    },

    skeletonRow() {
        return `<div class="nav-card" aria-hidden="true"><div class="skeleton-block" style="width:60%;height:16px;"></div><div class="skeleton-block" style="width:60px;height:16px;"></div></div>`;
    },

    skeletonFolio() {
        return `
            <div class="folio" aria-hidden="true">
                <div class="folio-header">
                    <div class="skeleton-block" style="width:140px;height:14px;"></div>
                    <div class="skeleton-block" style="width:80px;height:14px;"></div>
                </div>
                <div class="folio-body">
                    <div class="space-y-2">
                        <div class="skeleton-block" style="width:100%;height:12px;"></div>
                        <div class="skeleton-block" style="width:92%;height:12px;"></div>
                        <div class="skeleton-block" style="width:85%;height:12px;"></div>
                    </div>
                    <div class="folio-divider hidden lg:block"></div>
                    <div class="space-y-2">
                        <div class="skeleton-block" style="width:100%;height:12px;"></div>
                        <div class="skeleton-block" style="width:88%;height:12px;"></div>
                    </div>
                </div>
            </div>`;
    },

    emptyState(message) {
        return `
            <div class="folio text-center py-16 px-6">
                <p class="font-display text-lg text-[var(--ink-soft)] mb-1">Nothing here</p>
                <p class="font-mono-app text-[12px] text-[var(--ink-faint)]">${Utils.escapeHtml(message)}</p>
            </div>`;
    },

    errorState() {
        return `
            <div class="folio text-center py-16 px-6" style="border-color: var(--rubric-line);">
                <p class="font-display text-lg mb-1" style="color: var(--rubric);">Could not load the archive</p>
                <p class="font-mono-app text-[12px] text-[var(--ink-faint)] mb-4 max-w-md mx-auto">The remote database didn't respond after 3 attempts. Open the browser console (F12) for the exact error — often a rate limit or brief outage on raw.githubusercontent.com.</p>
                <button type="button" data-role="retry-load" class="font-mono-app text-[11px] tracking-[0.12em] uppercase px-4 py-2 rounded-md border transition-colors" style="color: var(--rubric); border-color: var(--rubric-line);">Retry now</button>
            </div>`;
    },

    errataSlip(misquote, query) {
        return `
            <div class="errata-slip">
                <div class="errata-row">
                    <span class="errata-mark" style="color: var(--rubric);">✕</span>
                    <p>
                        <span class="errata-label" style="color: var(--rubric);">Circulated as</span>
                        <span style="color: var(--rubric);">${Utils.highlight(misquote.claim, query)}</span>
                    </p>
                </div>
                <div class="errata-row">
                    <span class="errata-mark" style="color: var(--verdigris);">✓</span>
                    <p>
                        <span class="errata-label" style="color: var(--verdigris);">Correction</span>
                        <span>${Utils.highlight(misquote.correction, query)}</span>
                    </p>
                </div>
            </div>`;
    },

    folio(hadith, query) {
        const hasMisquotes = Array.isArray(hadith.misquotes) && hadith.misquotes.length > 0;

        return `
            <article class="folio">
                <div class="folio-header">
                    <span class="folio-ref">${Utils.escapeHtml(hadith.book)} · No. ${Utils.escapeHtml(String(hadith.number))}</span>
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-mono-app text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded border" style="color: var(--verdigris); border-color: var(--verdigris); background: var(--verdigris-soft);">${Utils.escapeHtml(hadith.grade)}</span>
                        <span class="font-mono-app text-[10.5px] px-2 py-0.5 rounded" style="color: var(--ink-soft); background: var(--parchment-sunken);">${Utils.highlight(hadith.chapter, query)}</span>
                    </div>
                </div>

                <div class="folio-body">
                    <div class="folio-english order-2 lg:order-1">${Utils.highlight(hadith.english, query)}</div>
                    <div class="folio-divider order-1 lg:order-2 hidden lg:block"></div>
                    <div class="folio-arabic order-1 lg:order-3">${Utils.escapeHtml(hadith.arabic)}</div>
                </div>

                <div class="folio-utility">
                    <button type="button" data-role="copy" data-id="${hadith.id}" class="flex items-center gap-1.5 hover:text-[var(--verdigris)] transition-colors">
                        <span aria-hidden="true">⎘</span><span>Copy text</span>
                    </button>
                </div>

                <div>
                    <button type="button" data-role="toggle-accordion" data-prefix="commentary" data-id="${hadith.id}"
                            aria-expanded="false" aria-controls="commentary-panel-${hadith.id}"
                            class="accordion-trigger" style="color: var(--verdigris);">
                        <span>Scholarly commentary</span>
                        <span id="commentary-chevron-${hadith.id}" class="accordion-chevron" aria-hidden="true">▾</span>
                    </button>
                    <div id="commentary-panel-${hadith.id}" class="accordion-panel hidden" style="color: var(--ink-soft); font-size: 14px; line-height: 1.75;">
                        ${Utils.highlight(hadith.explanation, query)}
                    </div>
                </div>

                ${hasMisquotes ? `
                <div>
                    <button type="button" data-role="toggle-accordion" data-prefix="radd" data-id="${hadith.id}"
                            aria-expanded="false" aria-controls="radd-panel-${hadith.id}"
                            class="accordion-trigger" style="color: var(--rubric);">
                        <span>Common misquotes &amp; correction (radd)</span>
                        <span id="radd-chevron-${hadith.id}" class="accordion-chevron" aria-hidden="true">▾</span>
                    </button>
                    <div id="radd-panel-${hadith.id}" class="accordion-panel hidden space-y-3">
                        ${hadith.misquotes.map(m => Templates.errataSlip(m, query)).join('')}
                        <p class="font-mono-app text-[10px] italic" style="color: var(--ink-faint);">Community-compiled — verify exact wording with a qualified scholar.</p>
                    </div>
                </div>` : ''}
            </article>`;
    },

    breadcrumbs() {
        const { view, activeCollection, activeChapter, query } = Store.state;
        if (view === 'collections') return '';

        const crumbs = [{ label: 'All Collections', role: 'crumb-home' }];
        if (view === 'search') {
            crumbs.push({ label: `Search results for "${query}"`, role: null });
        } else {
            crumbs.push({ label: activeCollection, role: view === 'list' ? 'crumb-collection' : null, book: activeCollection });
            if (activeChapter) crumbs.push({ label: activeChapter, role: null });
        }

        return crumbs.map((c, i) => {
            const sep = i > 0 ? '<span class="breadcrumb-sep" aria-hidden="true">›</span>' : '';
            const text = Utils.escapeHtml(c.label);
            if (!c.role) return `${sep}<span class="breadcrumb-current">${text}</span>`;
            const bookAttr = c.book ? ` data-book="${Utils.escapeHtml(c.book)}"` : '';
            return `${sep}<button type="button" class="breadcrumb-link" data-role="${c.role}"${bookAttr}>${text}</button>`;
        }).join('');
    }
};

/* =====================================================================
   RENDER — the only code that touches the DOM
   ===================================================================== */
const Render = {
    breadcrumbs() {
        document.getElementById('breadcrumbs').innerHTML = Templates.breadcrumbs();
    },

    counter() {
        const badge = document.getElementById('counterBadge');
        const { view, all, activeCollection, activeChapter, query } = Store.state;
        let text = '';
        if (view === 'collections') {
            text = `${Store.collections().length} collections · ${all.length} narrations total`;
        } else if (view === 'chapters') {
            text = `${Store.chaptersOf(activeCollection).length} chapters in ${activeCollection}`;
        } else if (view === 'list') {
            text = `${Store.hadithsOf(activeCollection, activeChapter).length} narrations`;
        } else if (view === 'search') {
            const n = Store.searchResults(query).length;
            text = `${n} matching narration${n === 1 ? '' : 's'}`;
        }
        badge.textContent = text;
        badge.classList.remove('opacity-0');
    },

    skeleton() {
        const container = document.getElementById('hadithContainer');
        container.innerHTML = Array.from({ length: 3 }, Templates.skeletonFolio).join('');
    },

    results() {
        const container = document.getElementById('hadithContainer');
        const loadMoreBtn = document.getElementById('loadMoreContainer');
        const { view, status } = Store.state;

        if (status === 'error') {
            container.innerHTML = Templates.errorState();
            loadMoreBtn.classList.add('hidden');
            return;
        }

        if (view === 'collections') {
            const cols = Store.collections();
            container.innerHTML = cols.length
                ? `<div class="space-y-3">${cols.map(c => Templates.navCard({
                        role: 'open-collection', book: c.name, title: c.name,
                        meta: `${c.count} narration${c.count === 1 ? '' : 's'}`, size: 'lg'
                    })).join('')}</div>`
                : Templates.emptyState('No collections in the archive yet.');
            loadMoreBtn.classList.add('hidden');
            return;
        }

        if (view === 'chapters') {
            const chapters = Store.chaptersOf(Store.state.activeCollection);
            container.innerHTML = chapters.length
                ? `<div class="space-y-3">${chapters.map(c => Templates.navCard({
                        role: 'open-chapter', book: Store.state.activeCollection, chapter: c.name, title: c.name,
                        meta: String(c.count)
                    })).join('')}</div>`
                : Templates.emptyState('No chapters found in this collection.');
            loadMoreBtn.classList.add('hidden');
            return;
        }

        // 'list' or 'search'
        const items = Store.visibleItems();
        if (items.length === 0) {
            container.innerHTML = Templates.emptyState('No narrations matched.');
            loadMoreBtn.classList.add('hidden');
            return;
        }
        container.innerHTML = items.map(h => Templates.folio(h, Store.state.query)).join('');
        loadMoreBtn.classList.toggle('hidden', !Store.hasMore());
    },

    all() {
        this.breadcrumbs();
        this.counter();
        this.results();
    }
};

/* =====================================================================
   ACTIONS
   ===================================================================== */
function toggleAccordion(prefix, id) {
    const panel = document.getElementById(`${prefix}-panel-${id}`);
    const chevron = document.getElementById(`${prefix}-chevron-${id}`);
    const trigger = chevron.closest('button');
    const willOpen = panel.classList.contains('hidden');

    panel.classList.toggle('hidden', !willOpen);
    chevron.classList.toggle('is-open', willOpen);
    trigger.setAttribute('aria-expanded', String(willOpen));
}

function copyHadith(id, buttonEl) {
    const item = Store.state.all.find(h => h.id === id);
    if (!item) return;

    let text = `[${item.book} - Hadith No. ${item.number}]\n\nArabic:\n${item.arabic}\n\nEnglish:\n${item.english}\n\nCommentary:\n${item.explanation}`;
    if (Array.isArray(item.misquotes) && item.misquotes.length > 0) {
        text += '\n\nCommon Misquotes & Correction (Radd):\n' + item.misquotes
            .map(m => `✕ Circulated as: ${m.claim}\n✓ Correction: ${m.correction}`)
            .join('\n\n');
    }

    navigator.clipboard.writeText(text).then(() => {
        const label = buttonEl.querySelector('span:last-child');
        const original = label.textContent;
        label.textContent = 'Copied';
        buttonEl.style.color = 'var(--verdigris)';
        setTimeout(() => {
            label.textContent = original;
            buttonEl.style.color = '';
        }, 1500);
    }).catch(err => console.error('Clipboard write failed:', err));
}

// Single delegated click handler for every interactive element rendered
// by Templates — avoids inline onclick handlers and per-element listeners.
function handleDelegatedClick(e) {
    const el = e.target.closest('[data-role]');
    if (!el) return;
    const { role, book, chapter, prefix, id } = el.dataset;

    switch (role) {
        case 'crumb-home':
            Store.goToCollections();
            Render.all();
            break;
        case 'crumb-collection':
        case 'open-collection':
            Store.goToCollection(book);
            Render.all();
            break;
        case 'open-chapter':
            Store.goToChapter(book, chapter);
            Render.all();
            break;
        case 'load-more':
            Store.loadMore();
            Render.results();
            Render.counter();
            break;
        case 'copy':
            copyHadith(Number(id), el);
            break;
        case 'toggle-accordion':
            toggleAccordion(prefix, Number(id));
            break;
        case 'retry-load':
            Store.state.status = 'loading';
            Render.skeleton();
            Store.load().then(() => Render.all());
            break;
    }
}

/* =====================================================================
   THEME
   ===================================================================== */
function setupTheme() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const saved = localStorage.getItem('theme');
    document.documentElement.classList.toggle('dark', saved === 'dark' || (!saved && prefersDark));
}

function setupThemeToggle() {
    document.getElementById('themeToggle').addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });
}

/* =====================================================================
   SEARCH
   ===================================================================== */
function setupSearch() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearchBtn');

    const runSearch = Utils.debounce(() => {
        Store.setQuery(input.value);
        Render.all();
    }, 250);

    input.addEventListener('input', () => {
        clearBtn.classList.toggle('hidden', input.value.length === 0);
        runSearch();
    });

    clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.classList.add('hidden');
        Store.setQuery('');
        Render.all();
        input.focus();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== input) {
            e.preventDefault();
            input.focus();
            input.select();
        }
    });
}

/* =====================================================================
   INIT
   ===================================================================== */
async function init() {
    setupTheme();
    setupThemeToggle();
    setupSearch();
    document.addEventListener('click', handleDelegatedClick);

    Render.skeleton();
    await Store.load();
    Render.all();
}

document.addEventListener('DOMContentLoaded', init);