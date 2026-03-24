let allTemplates = [];
let currentSort = { key: 'total', asc: false };
const PAGE_SIZE = 25;
let currentPage = 0;

function getTemplateFilterParams() {
    const dir = document.getElementById('directionFilter')?.value || '';
    const status = getStatusFilterValues();
    const showUnused = document.getElementById('showUnused')?.checked ? '1' : '0';
    let params = getDateParams() + getAccountFilterParam();
    if (dir) params += `&direction=${dir}`;
    if (status) params += `&status=${encodeURIComponent(status)}`;
    params += `&include_unused=${showUnused}`;
    return params;
}

window._onAccountFilterChange = loadTemplates;

async function loadTemplates() {
    const filterParams = getTemplateFilterParams();
    const cacheKey = `templates_${filterParams}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        const data = JSON.parse(cached);
        allTemplates = data.templates;
        currentPage = 0;
        applyClientFilters();
        return;
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
        const res = await fetchWithDedup(`/api/templates?${filterParams}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${res.status})`);
        }
        const data = await res.json();
        safeCacheSet(cacheKey, data);
        if (data.partial_data && data.warnings) showPartialDataWarning(data.warnings);
        else if (data.warnings && data.warnings.length) showWarning(data.warnings);
        allTemplates = data.templates;
        currentPage = 0;
        applyClientFilters();
        setLastUpdated();
        hideLoading();
    } catch(e) {
        showError(e.name === 'AbortError' ? 'Request timed out. Try a shorter date range.' : e.message);
    }
}

// Filter change handlers - server-side filters trigger a fresh load
const debouncedLoad = debounce(loadTemplates, 300);
document.getElementById('directionFilter').addEventListener('change', () => {
    if (window.updateURLFilters) updateURLFilters();
    debouncedLoad();
});
document.getElementById('statusFilter').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') {
        if (window.updateURLFilters) updateURLFilters();
        debouncedLoad();
    }
});
document.getElementById('showUnused').addEventListener('change', loadTemplates);

// Client-side filters (type + search) — no server call needed
document.getElementById('typeFilter').addEventListener('change', applyClientFilters);
document.getElementById('templateSearch').addEventListener('input', applyClientFilters);

// Pagination controls
document.getElementById('prevPage').addEventListener('click', () => {
    if (currentPage > 0) { currentPage--; renderFromFiltered(); }
});
document.getElementById('nextPage').addEventListener('click', () => {
    currentPage++;
    renderFromFiltered();
});

// Initial load — wait for account filter to be ready
window.accountsReady.then(() => loadTemplates());

let lastFiltered = [];

function applyClientFilters() {
    let filtered = allTemplates;

    // Type filter
    const typeVal = document.getElementById('typeFilter')?.value || '';
    if (typeVal === 'content_sid') {
        filtered = filtered.filter(t => !t.template_type.includes('no content_sid'));
    } else if (typeVal === 'no_content_sid') {
        filtered = filtered.filter(t => t.template_type.includes('no content_sid'));
    }

    // Search filter
    const query = document.getElementById('templateSearch').value.toLowerCase();
    if (query) {
        filtered = filtered.filter(t =>
            t.template_name.toLowerCase().includes(query) ||
            (t.body || '').toLowerCase().includes(query));
    }

    currentPage = 0;
    lastFiltered = filtered;
    renderFromFiltered();
}

function renderFromFiltered() {
    const filtered = lastFiltered;
    renderKpis(filtered);
    renderRatesChart(filtered);

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    const pageSlice = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    renderTable(pageSlice, filtered);
    renderPagination(filtered.length);

    // Update export button text with count
    const exportBtn = document.getElementById('exportTemplatesCSV');
    if (exportBtn) exportBtn.textContent = `Export All (${filtered.length})`;

    const empty = document.getElementById('emptyState');
    const table = document.getElementById('templatesTable');
    if (filtered.length === 0) {
        empty.style.display = 'block';
        table.style.display = 'none';
    } else {
        empty.style.display = 'none';
        table.style.display = '';
    }
}

function renderPagination(total) {
    const paginationEl = document.getElementById('pagination');
    const totalPages = Math.ceil(total / PAGE_SIZE);
    if (totalPages <= 1) {
        paginationEl.style.display = 'none';
        return;
    }
    paginationEl.style.display = 'flex';
    document.getElementById('pageInfo').textContent = `Page ${currentPage + 1} of ${totalPages} (${total} templates)`;
    document.getElementById('prevPage').disabled = currentPage === 0;
    document.getElementById('nextPage').disabled = currentPage >= totalPages - 1;
}

function renderKpis(templates) {
    document.getElementById('kpiTotalTemplates').textContent = templates.length;

    if (templates.length > 0) {
        const avgDelivery = templates.reduce((s, t) => s + t.delivery_rate, 0) / templates.length;
        const avgRead = templates.reduce((s, t) => s + t.read_rate, 0) / templates.length;
        document.getElementById('kpiAvgDelivery').textContent = avgDelivery.toFixed(1) + '%';
        document.getElementById('kpiAvgRead').textContent = avgRead.toFixed(1) + '%';

        const top = [...templates].sort((a, b) => b.delivery_rate - a.delivery_rate)[0];
        document.getElementById('kpiTopPerformer').textContent = top.template_name.substring(0, 20);
        document.getElementById('kpiTopPerformer').title = top.template_name;
    } else {
        document.getElementById('kpiAvgDelivery').textContent = '-';
        document.getElementById('kpiAvgRead').textContent = '-';
        document.getElementById('kpiTopPerformer').textContent = '-';
    }
}

function renderTable(pageTemplates, allFiltered) {
    const tbody = document.getElementById('templatesBody');
    tbody.innerHTML = '';

    pageTemplates.forEach((t, i) => {
        // Main row
        const tr = document.createElement('tr');
        tr.className = 'template-row clickable';
        tr.dataset.index = i;
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-expanded', 'false');
        tr.innerHTML = `
            <td>
                <span class="expand-icon">&#9654;</span>
                <strong>${escapeHtml(t.template_name)}</strong>
            </td>
            <td>${escapeHtml(t.accounts || '-')}</td>
            <td>${t.total.toLocaleString()}</td>
            <td>${t.delivered.toLocaleString()}</td>
            <td>${t.read.toLocaleString()}</td>
            <td><span class="badge badge-success">${t.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${t.read_rate}%</span></td>
        `;

        // Expandable detail row
        const detailTr = document.createElement('tr');
        detailTr.className = 'template-detail-row';
        detailTr.style.display = 'none';
        detailTr.innerHTML = `
            <td colspan="7">
                <div class="template-body-container">
                    <div class="template-body-header">
                        <span class="template-body-label">Template Body</span>
                        ${t.template_id ? `<span class="template-sid">${escapeHtml(t.template_id)}</span>` : ''}
                    </div>
                    <div class="template-body-text">${escapeHtml(t.body || 'No body text available')}</div>
                    <div class="template-body-stats">
                        <div class="stat-pill"><span class="stat-label">Total Sent</span><span class="stat-value">${t.total.toLocaleString()}</span></div>
                        <div class="stat-pill stat-success"><span class="stat-label">Delivered</span><span class="stat-value">${t.delivered.toLocaleString()}</span></div>
                        <div class="stat-pill stat-info"><span class="stat-label">Read</span><span class="stat-value">${t.read.toLocaleString()}</span></div>
                    </div>
                </div>
            </td>
        `;

        function toggleRow() {
            const isOpen = detailTr.style.display !== 'none';
            detailTr.style.display = isOpen ? 'none' : 'table-row';
            tr.querySelector('.expand-icon').innerHTML = isOpen ? '&#9654;' : '&#9660;';
            tr.classList.toggle('expanded', !isOpen);
            tr.setAttribute('aria-expanded', String(!isOpen));
        }
        tr.addEventListener('click', toggleRow);
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(); }
        });

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);
    });

    // Sorting - sorts the full filtered list, then re-renders current page
    document.querySelectorAll('#templatesTable thead th').forEach(th => {
        th.onclick = () => {
            const key = th.dataset.sort;
            if (!key) return;
            if (currentSort.key === key) {
                currentSort.asc = !currentSort.asc;
            } else {
                currentSort.key = key;
                currentSort.asc = false;
            }
            lastFiltered = [...allFiltered].sort((a, b) => {
                const av = a[key], bv = b[key];
                let cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
                return currentSort.asc ? cmp : -cmp;
            });
            updateSortIndicators(key);
            renderFromFiltered();
        };
    });

    updateSortIndicators(currentSort.key);
}

function updateSortIndicators(activeKey) {
    document.querySelectorAll('#templatesTable thead th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === activeKey) {
            th.classList.add(currentSort.asc ? 'sort-asc' : 'sort-desc');
        }
    });
}

let ratesChartInstance = null;

document.getElementById('exportTemplatesCSV')?.addEventListener('click', () => {
    const headers = ['Template Name', 'Sub Account', 'Body', 'Total', 'Delivered', 'Read', 'Delivery Rate', 'Read Rate'];
    const rows = lastFiltered.map(t => [
        t.template_name, t.accounts || '', t.body || '', t.total, t.delivered, t.read,
        t.delivery_rate + '%', t.read_rate + '%'
    ]);
    exportCSV(csvFilename('templates'), headers, rows);
});

function renderRatesChart(templates) {
    if (ratesChartInstance) ratesChartInstance.destroy();
    const top = templates.slice(0, 10);
    ratesChartInstance = safeChart('ratesChart', {
        type: 'bar',
        data: {
            labels: top.map(t => t.template_name.substring(0, 25)),
            datasets: [
                { label: 'Delivery Rate', data: top.map(t => t.delivery_rate), backgroundColor: '#25d366' },
                { label: 'Read Rate', data: top.map(t => t.read_rate), backgroundColor: '#0dcaf0' }
            ]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: 'Rate (%)' } } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}
