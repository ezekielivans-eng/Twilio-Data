let statusChartInstance = null;
let timelineChartInstance = null;
let subaccountsChartInstance = null;
let templatesChartInstance = null;
let currentTopSubaccounts = [];
let currentTopTemplates = [];

function getFilterParams() {
    const dir = document.getElementById('directionFilter')?.value || '';
    const status = getStatusFilterValues();
    let params = getDateParams() + getAccountFilterParam();
    if (dir) params += `&direction=${dir}`;
    if (status) params += `&status=${encodeURIComponent(status)}`;
    return params;
}

window._onAccountFilterChange = loadDashboard;

async function loadDashboard() {
    const filterParams = getFilterParams();
    const cacheKey = `dashboard_${filterParams}`;
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
        const res = await fetch(`/api/dashboard?${filterParams}`, { signal: controller.signal });
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
document.getElementById('directionFilter')?.addEventListener('change', loadDashboard);
document.getElementById('statusFilter')?.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') loadDashboard();
});

// Initial load — wait for account filter to be ready
window.accountsReady.then(() => loadDashboard());

function renderPage(data) {
    if (data.warnings && data.warnings.length) showWarning(data.warnings);
    renderKPIs(data.status_summary);
    renderStatusChart(data.status_summary);
    renderTimelineChart(data.daily);
    renderSubaccountsChart(data.top_subaccounts);
    renderTemplatesChart(data.top_templates);
    renderTopSubaccountsTable(data.top_subaccounts);
    renderTopTemplatesTable(data.top_templates);
    currentTopSubaccounts = data.top_subaccounts;
    currentTopTemplates = data.top_templates;
    if (data.limit_reached) {
        showLimitWarning();
    }
    setLastUpdated();
    hideLoading();
}

function showLimitWarning() {
    const existing = document.querySelector('.limit-warning');
    if (existing) return;
    const warn = document.createElement('div');
    warn.className = 'limit-warning';
    warn.innerHTML = 'Some accounts hit the message fetch limit. Totals may be approximate. Try a shorter date range for exact numbers.';
    document.querySelector('.container').insertBefore(warn, document.getElementById('loading').nextSibling);
}

function renderKPIs(s) {
    document.getElementById('kpiTotal').textContent = s.total.toLocaleString();
    document.getElementById('kpiDelivery').textContent = s.delivery_rate + '%';
    document.getElementById('kpiRead').textContent = s.read_rate + '%';
    document.getElementById('kpiError').textContent = s.error_rate + '%';
}

function renderStatusChart(s) {
    if (statusChartInstance) statusChartInstance.destroy();
    statusChartInstance = new Chart(document.getElementById('statusChart'), {
        type: 'doughnut',
        data: {
            labels: ['Delivered', 'Read', 'Sent', 'Failed', 'Undelivered', 'Queued'],
            datasets: [{
                data: [s.delivered, s.read, s.sent, s.failed, s.undelivered, s.queued],
                backgroundColor: ['#25d366', '#0dcaf0', '#ffc107', '#dc3545', '#fd7e14', '#6c757d']
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderTimelineChart(daily) {
    if (timelineChartInstance) timelineChartInstance.destroy();
    const colors = {
        delivered: '#25d366', read: '#0dcaf0', sent: '#ffc107',
        failed: '#dc3545', undelivered: '#fd7e14', queued: '#6c757d'
    };
    const datasets = Object.entries(daily.series).map(([status, values]) => ({
        label: status.charAt(0).toUpperCase() + status.slice(1),
        data: values,
        borderColor: colors[status] || '#999',
        backgroundColor: (colors[status] || '#999') + '20',
        fill: true,
        tension: 0.3
    }));

    timelineChartInstance = new Chart(document.getElementById('timelineChart'), {
        type: 'line',
        data: { labels: daily.dates, datasets },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderSubaccountsChart(subaccounts) {
    if (subaccountsChartInstance) subaccountsChartInstance.destroy();
    const top = subaccounts.slice(0, 8);
    subaccountsChartInstance = new Chart(document.getElementById('subaccountsChart'), {
        type: 'bar',
        data: {
            labels: top.map(a => a.friendly_name),
            datasets: [{
                label: 'Total Messages',
                data: top.map(a => a.total_messages),
                backgroundColor: '#25d366'
            }]
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            plugins: { legend: { display: false } }
        }
    });
}

function renderTemplatesChart(templates) {
    if (templatesChartInstance) templatesChartInstance.destroy();
    const top = templates.slice(0, 8);
    templatesChartInstance = new Chart(document.getElementById('templatesChart'), {
        type: 'bar',
        data: {
            labels: top.map(t => t.template_name.substring(0, 30)),
            datasets: [
                { label: 'Delivery Rate', data: top.map(t => t.delivery_rate), backgroundColor: '#25d366' },
                { label: 'Read Rate', data: top.map(t => t.read_rate), backgroundColor: '#0dcaf0' }
            ]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, max: 100 } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderTopSubaccountsTable(subaccounts) {
    document.getElementById('topSubaccountsBody').innerHTML = subaccounts.map(a => `
        <tr class="clickable" onclick="window.location='/subaccounts/${encodeURIComponent(a.sid)}?${getDateParams()}'">
            <td><strong>${escapeHtml(a.friendly_name)}</strong></td>
            <td>${a.total_messages.toLocaleString()}</td>
            <td>${a.delivered.toLocaleString()}</td>
            <td>${a.read.toLocaleString()}</td>
            <td>${a.failed.toLocaleString()}</td>
            <td><span class="badge badge-success">${a.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${a.read_rate}%</span></td>
            <td><span class="badge ${a.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${a.error_rate}%</span></td>
        </tr>
    `).join('');
}

function renderTopTemplatesTable(templates) {
    document.getElementById('topTemplatesBody').innerHTML = templates.map(t => `
        <tr>
            <td>${escapeHtml(t.template_name)}</td>
            <td>${t.total.toLocaleString()}</td>
            <td>${t.delivered.toLocaleString()}</td>
            <td>${t.read.toLocaleString()}</td>
            <td>${t.failed.toLocaleString()}</td>
            <td><span class="badge badge-success">${t.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${t.read_rate}%</span></td>
            <td><span class="badge ${t.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${t.error_rate}%</span></td>
        </tr>
    `).join('');
}

document.getElementById('exportSubaccountsCSV')?.addEventListener('click', () => {
    const headers = ['Account Name', 'Total Messages', 'Delivered', 'Read', 'Failed', 'Delivery Rate', 'Read Rate', 'Error Rate'];
    const rows = currentTopSubaccounts.map(a => [
        a.friendly_name, a.total_messages, a.delivered, a.read, a.failed,
        a.delivery_rate + '%', a.read_rate + '%', a.error_rate + '%'
    ]);
    exportCSV('dashboard_subaccounts.csv', headers, rows);
});

document.getElementById('exportTemplatesCSV')?.addEventListener('click', () => {
    const headers = ['Template Name', 'Total', 'Delivered', 'Read', 'Failed', 'Delivery Rate', 'Read Rate', 'Error Rate'];
    const rows = currentTopTemplates.map(t => [
        t.template_name, t.total, t.delivered, t.read, t.failed,
        t.delivery_rate + '%', t.read_rate + '%', t.error_rate + '%'
    ]);
    exportCSV('dashboard_templates.csv', headers, rows);
});
