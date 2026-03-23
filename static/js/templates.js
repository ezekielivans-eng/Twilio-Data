let allTemplates = [];
let currentSort = { key: 'total', asc: false };

function getTemplateFilterParams() {
    const dir = document.getElementById('directionFilter')?.value || '';
    const status = getStatusFilterValues();
    let params = getDateParams() + getAccountFilterParam();
    if (dir) params += `&direction=${dir}`;
    if (status) params += `&status=${encodeURIComponent(status)}`;
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
        applyClientFilters();
        return;
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        const res = await fetch(`/api/templates?${filterParams}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${res.status})`);
        }
        const data = await res.json();
        safeCacheSet(cacheKey, data);
        allTemplates = data.templates;
        applyClientFilters();
        hideLoading();
    } catch(e) {
        showError(e.name === 'AbortError' ? 'Request timed out. Try a shorter date range.' : e.message);
    }
}

// Filter change handlers - all trigger a fresh load
document.getElementById('directionFilter').addEventListener('change', loadTemplates);
document.getElementById('statusFilter').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') loadTemplates();
});

// Client-side filters (type + search) — no server call needed
document.getElementById('typeFilter').addEventListener('change', applyClientFilters);
document.getElementById('templateSearch').addEventListener('input', applyClientFilters);

// Initial load — wait for account filter to be ready
window.accountsReady.then(() => loadTemplates());

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

    renderAll(filtered);
}

function renderAll(templates) {
    renderKpis(templates);
    renderTable(templates);
    renderRatesChart(templates);

    const empty = document.getElementById('emptyState');
    const table = document.getElementById('templatesTable');
    if (templates.length === 0) {
        empty.style.display = 'block';
        table.style.display = 'none';
    } else {
        empty.style.display = 'none';
        table.style.display = '';
    }
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

function renderTable(templates) {
    const tbody = document.getElementById('templatesBody');
    tbody.innerHTML = '';

    templates.forEach((t, i) => {
        // Main row
        const tr = document.createElement('tr');
        tr.className = 'template-row clickable';
        tr.dataset.index = i;
        tr.innerHTML = `
            <td>
                <span class="expand-icon">&#9654;</span>
                <strong>${escapeHtml(t.template_name)}</strong>
            </td>
            <td><span class="type-badge type-${t.template_type || 'unknown'}">${escapeHtml(t.template_type || 'unknown')}</span></td>
            <td>${t.total.toLocaleString()}</td>
            <td>${t.delivered.toLocaleString()}</td>
            <td>${t.read.toLocaleString()}</td>
            <td>${t.failed.toLocaleString()}</td>
            <td><span class="badge badge-success">${t.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${t.read_rate}%</span></td>
            <td><span class="badge ${t.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${t.error_rate}%</span></td>
        `;

        // Expandable detail row
        const detailTr = document.createElement('tr');
        detailTr.className = 'template-detail-row';
        detailTr.style.display = 'none';
        detailTr.innerHTML = `
            <td colspan="9">
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
                        <div class="stat-pill stat-danger"><span class="stat-label">Failed</span><span class="stat-value">${t.failed.toLocaleString()}</span></div>
                        <div class="stat-pill"><span class="stat-label">Undelivered</span><span class="stat-value">${t.undelivered.toLocaleString()}</span></div>
                    </div>
                </div>
            </td>
        `;

        tr.addEventListener('click', () => {
            const isOpen = detailTr.style.display !== 'none';
            detailTr.style.display = isOpen ? 'none' : 'table-row';
            tr.querySelector('.expand-icon').innerHTML = isOpen ? '&#9654;' : '&#9660;';
            tr.classList.toggle('expanded', !isOpen);
        });

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);
    });

    // Sorting
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
            const sorted = [...templates].sort((a, b) => {
                const av = a[key], bv = b[key];
                let cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
                return currentSort.asc ? cmp : -cmp;
            });
            renderTable(sorted);
        };
    });
}

let ratesChartInstance = null;

function renderRatesChart(templates) {
    if (ratesChartInstance) ratesChartInstance.destroy();
    const top = templates.slice(0, 10);
    ratesChartInstance = new Chart(document.getElementById('ratesChart'), {
        type: 'bar',
        data: {
            labels: top.map(t => t.template_name.substring(0, 25)),
            datasets: [
                { label: 'Delivery Rate', data: top.map(t => t.delivery_rate), backgroundColor: '#25d366' },
                { label: 'Read Rate', data: top.map(t => t.read_rate), backgroundColor: '#0dcaf0' },
                { label: 'Error Rate', data: top.map(t => t.error_rate), backgroundColor: '#dc3545' }
            ]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: 'Rate (%)' } } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

