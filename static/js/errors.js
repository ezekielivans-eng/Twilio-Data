let statusChartInstance = null;
let errorCodesChartInstance = null;
let currentErrors = [];
let currentSort = { key: 'count', asc: false };

window._onAccountFilterChange = loadErrors;

function getErrorFilterParams() {
    const dir = document.getElementById('directionFilter')?.value || '';
    let params = getDateParams() + getAccountFilterParam();
    if (dir) params += `&direction=${dir}`;
    return params;
}

async function loadErrors() {
    const filterParams = getErrorFilterParams();
    const cacheKey = `errors_${filterParams}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        const data = JSON.parse(cached);
        renderPage(data);
        return;
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
        const res = await fetchWithDedup(`/api/errors?${filterParams}`, { signal: controller.signal });
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

// Filter change handler
const debouncedLoadErrors = debounce(loadErrors, 300);
document.getElementById('directionFilter')?.addEventListener('change', () => {
    if (window.updateURLFilters) updateURLFilters();
    debouncedLoadErrors();
});

window.accountsReady.then(() => loadErrors());

function renderPage(data) {
    if (data.partial_data && data.warnings) showPartialDataWarning(data.warnings);
    else if (data.warnings && data.warnings.length) showWarning(data.warnings);

    const empty = document.getElementById('emptyState');
    if (empty) empty.style.display = (data.summary?.total || 0) === 0 ? 'block' : 'none';

    renderKPIs(data.summary);
    renderStatusChart(data.summary);
    renderErrorCodesChart(data.errors);
    renderTable(data.errors);
    currentErrors = data.errors;
    setLastUpdated();
    hideLoading();
}

function renderKPIs(s) {
    document.getElementById('kpiTotalErrors').textContent = s.total.toLocaleString();
    document.getElementById('kpiFailed').textContent = s.failed.toLocaleString();
    document.getElementById('kpiUndelivered').textContent = s.undelivered.toLocaleString();
}

function renderStatusChart(s) {
    if (statusChartInstance) statusChartInstance.destroy();
    statusChartInstance = safeChart('statusChart', {
        type: 'doughnut',
        data: {
            labels: ['Failed', 'Undelivered'],
            datasets: [{
                data: [s.failed, s.undelivered],
                backgroundColor: ['#dc3545', '#fd7e14']
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderErrorCodesChart(errors) {
    if (errorCodesChartInstance) errorCodesChartInstance.destroy();
    const top = errors.slice(0, 10);
    const colors = ['#dc3545','#fd7e14','#ffc107','#6c757d','#198754','#0dcaf0','#6f42c1','#d63384','#0d6efd','#adb5bd'];
    errorCodesChartInstance = safeChart('errorCodesChart', {
        type: 'bar',
        data: {
            labels: top.map(e => String(e.error_code)),
            datasets: [{
                label: 'Count',
                data: top.map(e => e.count),
                backgroundColor: colors.slice(0, top.length)
            }]
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            plugins: { legend: { display: false } }
        }
    });
}

function renderTable(errors) {
    const tbody = document.getElementById('errorsBody');
    tbody.innerHTML = errors.map(e => `
        <tr>
            <td><strong>${escapeHtml(String(e.error_code))}</strong></td>
            <td>${e.count.toLocaleString()}</td>
            <td>${e.pct}%</td>
            <td>${e.statuses.failed.toLocaleString()}</td>
            <td>${e.statuses.undelivered.toLocaleString()}</td>
        </tr>
    `).join('');

    // Sorting
    document.querySelectorAll('#errorsTable thead th').forEach(th => {
        th.onclick = () => {
            const key = th.dataset.sort;
            if (!key) return;
            if (currentSort.key === key) {
                currentSort.asc = !currentSort.asc;
            } else {
                currentSort.key = key;
                currentSort.asc = false;
            }
            const sorted = [...errors].sort((a, b) => {
                const av = a[key], bv = b[key];
                let cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : av - bv;
                return currentSort.asc ? cmp : -cmp;
            });
            updateSortIndicators(key);
            renderTable(sorted);
        };
    });
    updateSortIndicators(currentSort.key);
}

function updateSortIndicators(activeKey) {
    document.querySelectorAll('#errorsTable thead th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === activeKey) {
            th.classList.add(currentSort.asc ? 'sort-asc' : 'sort-desc');
        }
    });
}

document.getElementById('exportErrorsCSV')?.addEventListener('click', () => {
    const headers = ['Error Code', 'Count', '% of Errors', 'Failed', 'Undelivered'];
    const rows = currentErrors.map(e => [
        e.error_code, e.count, e.pct + '%', e.statuses.failed, e.statuses.undelivered
    ]);
    exportCSV(csvFilename('errors'), headers, rows);
});
