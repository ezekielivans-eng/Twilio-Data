let spendChartInstance = null;
let currentSort = { key: 'total_messages', asc: false };
let currentSubaccounts = [];

function getSubFilterParams() {
    const dir = document.getElementById('directionFilter')?.value || '';
    const status = getStatusFilterValues();
    let params = getDateParams() + getAccountFilterParam();
    if (dir) params += `&direction=${dir}`;
    if (status) params += `&status=${encodeURIComponent(status)}`;
    return params;
}

window._onAccountFilterChange = loadSubaccounts;

async function loadSubaccounts() {
    const filterParams = getSubFilterParams();
    const cacheKey = `subaccounts_${filterParams}`;
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
        const res = await fetchWithDedup(`/api/subaccounts?${filterParams}`, { signal: controller.signal });
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
const debouncedLoad = debounce(loadSubaccounts, 300);
document.getElementById('directionFilter')?.addEventListener('change', () => {
    if (window.updateURLFilters) updateURLFilters();
    showLoading();
    debouncedLoad();
});
document.getElementById('statusFilter')?.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') {
        if (window.updateURLFilters) updateURLFilters();
        showLoading();
        debouncedLoad();
    }
});

// Initial load — wait for account filter to be ready
window.accountsReady.then(() => loadSubaccounts());

function renderPage(data) {
    if (data.partial_data && data.warnings) showPartialDataWarning(data.warnings);
    else if (data.warnings && data.warnings.length) showWarning(data.warnings);
    const empty = document.getElementById('emptyState');
    const totalMsgs = data.subaccounts.reduce((s, a) => s + a.total_messages, 0);
    empty.style.display = totalMsgs === 0 ? 'block' : 'none';
    currentSubaccounts = data.subaccounts;
    renderTable(data.subaccounts);
    renderSpendChart(data.subaccounts);
    setLastUpdated();
    hideLoading();
}

function updateSortIndicators(activeKey) {
    document.querySelectorAll('#subaccountsTable thead th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === activeKey) {
            th.classList.add(currentSort.asc ? 'sort-asc' : 'sort-desc');
        }
    });
}

function renderTable(subaccounts) {
    const tbody = document.getElementById('subaccountsBody');
    tbody.innerHTML = subaccounts.map(a => `
        <tr class="clickable" onclick="window.location='/subaccounts/${encodeURIComponent(a.sid)}?${getDateParams()}'">
            <td><strong>${escapeHtml(a.friendly_name)}</strong>${a.limit_reached ? ' <span class="badge badge-warning" title="Message limit reached - totals approximate">~</span>' : ''}</td>
            <td>${a.total_messages.toLocaleString()}</td>
            <td>${a.delivered.toLocaleString()}</td>
            <td>${a.read.toLocaleString()}</td>
            <td><span class="badge badge-success">${a.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${a.read_rate}%</span></td>
            <td>$${a.spend.toFixed(2)}</td>
        </tr>
    `).join('');

    // Sorting
    document.querySelectorAll('#subaccountsTable thead th').forEach(th => {
        th.onclick = () => {
            const key = th.dataset.sort;
            if (!key) return;
            if (currentSort.key === key) {
                currentSort.asc = !currentSort.asc;
            } else {
                currentSort.key = key;
                currentSort.asc = false;
            }
            const sorted = [...subaccounts].sort((a, b) => {
                const av = a[key], bv = b[key];
                let cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
                return currentSort.asc ? cmp : -cmp;
            });
            updateSortIndicators(key);
            renderTable(sorted);
        };
    });

    updateSortIndicators(currentSort.key);
}

function renderSpendChart(subaccounts) {
    if (spendChartInstance) spendChartInstance.destroy();
    const top = subaccounts.filter(a => a.spend > 0).slice(0, 10);
    spendChartInstance = safeChart('spendChart', {
        type: 'bar',
        data: {
            labels: top.map(a => a.friendly_name),
            datasets: [{
                label: 'Spend ($)',
                data: top.map(a => a.spend),
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

document.getElementById('exportSubaccountsCSV')?.addEventListener('click', () => {
    const headers = ['Account Name', 'SID', 'Total Messages', 'Delivered', 'Read', 'Delivery Rate', 'Read Rate', 'Spend'];
    const rows = currentSubaccounts.map(a => [
        a.friendly_name, a.sid, a.total_messages, a.delivered, a.read,
        a.delivery_rate + '%', a.read_rate + '%', a.spend.toFixed(2)
    ]);
    exportCSV(csvFilename('subaccounts'), headers, rows);
});
