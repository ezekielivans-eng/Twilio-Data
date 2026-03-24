let statusChartInstance = null;
let timelineChartInstance = null;
let templateChartInstance = null;
let currentTemplates = [];

function getDetailFilterParams() {
    const dir = document.getElementById('directionFilter')?.value || '';
    const status = getStatusFilterValues();
    let params = getDateParams();
    if (dir) params += `&direction=${dir}`;
    if (status) params += `&status=${encodeURIComponent(status)}`;
    return params;
}

async function loadDetail() {
    const filterParams = getDetailFilterParams();
    const cacheKey = `subaccount_detail_${ACCOUNT_SID}_${filterParams}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        const data = JSON.parse(cached);
        renderPage(data);
        return;
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        const res = await fetchWithDedup(`/api/subaccounts/${ACCOUNT_SID}?${filterParams}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${res.status})`);
        }
        const data = await res.json();
        safeCacheSet(cacheKey, data);
        renderPage(data);
    } catch(e) {
        showError(e.name === 'AbortError' ? 'Request timed out. Try a shorter date range.' : e.message);
    }
}

// Filter change handlers
const debouncedLoad = debounce(loadDetail, 300);
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

// Initial load
loadDetail();

function renderPage(data) {
    if (data.warnings && data.warnings.length) showWarning(data.warnings);
    document.getElementById('accountTitle').textContent = `Sub-Account: ${data.account_name}`;
    renderKPIs(data.status_summary);
    renderStatusChart(data.status_summary);
    renderTimelineChart(data.daily);
    renderTemplateChart(data.templates);
    renderTemplatesTable(data.templates);
    currentTemplates = data.templates;
    if (data.limit_reached) {
        const existing = document.querySelector('.limit-warning');
        if (!existing) {
            const warn = document.createElement('div');
            warn.className = 'limit-warning';
            warn.innerHTML = 'Message fetch limit reached. Totals may be approximate. Try a shorter date range for exact numbers.';
            document.querySelector('.container').insertBefore(warn, document.getElementById('loading').nextSibling);
        }
    }
    setLastUpdated();
    hideLoading();
}

function renderKPIs(s) {
    document.getElementById('kpiTotal').textContent = s.total.toLocaleString();
    document.getElementById('kpiDelivery').textContent = s.delivery_rate + '%';
    document.getElementById('kpiRead').textContent = s.read_rate + '%';
    document.getElementById('kpiError').textContent = s.error_rate + '%';
}

function renderStatusChart(s) {
    if (statusChartInstance) statusChartInstance.destroy();
    statusChartInstance = safeChart('statusChart', {
        type: 'doughnut',
        data: {
            labels: ['Delivered', 'Read', 'Sent', 'Failed', 'Undelivered', 'Queued'],
            datasets: [{
                data: [s.delivered, s.read, s.sent, s.failed, s.undelivered, s.queued],
                backgroundColor: ['#25d366', '#0dcaf0', '#ffc107', '#dc3545', '#fd7e14', '#6c757d']
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
}

function renderTimelineChart(daily) {
    if (timelineChartInstance) timelineChartInstance.destroy();
    const colors = {
        delivered: '#25d366', read: '#0dcaf0', sent: '#ffc107',
        failed: '#dc3545', undelivered: '#fd7e14', queued: '#6c757d'
    };
    timelineChartInstance = safeChart('timelineChart', {
        type: 'line',
        data: {
            labels: daily.dates,
            datasets: Object.entries(daily.series).map(([status, values]) => ({
                label: status.charAt(0).toUpperCase() + status.slice(1),
                data: values,
                borderColor: colors[status] || '#999',
                backgroundColor: (colors[status] || '#999') + '20',
                fill: true, tension: 0.3
            }))
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderTemplateChart(templates) {
    if (templateChartInstance) templateChartInstance.destroy();
    const top = templates.slice(0, 10);
    templateChartInstance = safeChart('templateChart', {
        type: 'bar',
        data: {
            labels: top.map(t => t.template_name.substring(0, 30)),
            datasets: [
                { label: 'Delivery Rate', data: top.map(t => t.delivery_rate), backgroundColor: '#25d366' },
                { label: 'Read Rate', data: top.map(t => t.read_rate), backgroundColor: '#0dcaf0' },
                { label: 'Error Rate', data: top.map(t => t.error_rate), backgroundColor: '#dc3545' }
            ]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, max: 100 } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderTemplatesTable(templates) {
    const tbody = document.getElementById('templatesBody');
    tbody.innerHTML = '';

    templates.forEach((t) => {
        const tr = document.createElement('tr');
        tr.className = 'template-row clickable';
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-expanded', 'false');
        tr.innerHTML = `
            <td>
                <span class="expand-icon">&#9654;</span>
                ${escapeHtml(t.template_name)}
            </td>
            <td>${t.total.toLocaleString()}</td>
            <td>${t.delivered.toLocaleString()}</td>
            <td>${t.read.toLocaleString()}</td>
            <td>${t.failed.toLocaleString()}</td>
            <td><span class="badge badge-success">${t.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${t.read_rate}%</span></td>
            <td><span class="badge ${t.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${t.error_rate}%</span></td>
        `;

        const detailTr = document.createElement('tr');
        detailTr.className = 'template-detail-row';
        detailTr.style.display = 'none';
        detailTr.innerHTML = `
            <td colspan="8">
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
                        <div class="stat-pill"><span class="stat-label">Undelivered</span><span class="stat-value">${(t.undelivered || 0).toLocaleString()}</span></div>
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
}

document.getElementById('exportDetailCSV')?.addEventListener('click', () => {
    const headers = ['Template Name', 'Body', 'Total', 'Delivered', 'Read', 'Failed', 'Delivery Rate', 'Read Rate', 'Error Rate'];
    const rows = currentTemplates.map(t => [
        t.template_name, t.body || '', t.total, t.delivered, t.read, t.failed,
        t.delivery_rate + '%', t.read_rate + '%', t.error_rate + '%'
    ]);
    exportCSV('subaccount_templates.csv', headers, rows);
});
