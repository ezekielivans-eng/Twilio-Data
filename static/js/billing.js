let dailyChartInstance = null;
let pieChartInstance = null;
let categoryChartInstance = null;
let currentAccounts = [];

async function loadBilling() {
    const filterParams = getDateParams() + getAccountFilterParam();
    const cacheKey = `billing_${filterParams}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        try {
            renderPage(JSON.parse(cached));
            return;
        } catch (e) {
            sessionStorage.removeItem(cacheKey);
        }
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
        const res = await fetchWithDedup(`/api/billing?${filterParams}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.status === 429) { showError('Too many requests \u2014 please wait a moment and try again.'); return; }
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

window._onAccountFilterChange = loadBilling;
window.accountsReady.then(() => loadBilling());

function renderPage(data) {
    if (data.partial_data && data.warnings) showPartialDataWarning(data.warnings);
    else if (data.warnings && data.warnings.length) showWarning(data.warnings);
    const empty = document.getElementById('emptyState');
    empty.style.display = data.total_spend === 0 ? 'block' : 'none';
    renderKPIs(data);
    renderDailyChart(data.daily || []);
    renderPieChart(data.per_account);
    renderCategoryChart(data.per_account);
    renderTable(data.per_account);
    currentAccounts = data.per_account;
    setLastUpdated();
    hideLoading();
}

function renderKPIs(data) {
    document.getElementById('kpiTotalSpend').textContent = `$${data.total_spend.toFixed(2)}`;
    document.getElementById('kpiDailyAvg').textContent = `$${data.daily_average.toFixed(2)}`;
    document.getElementById('kpiProjected').textContent =
        data.projected_monthly != null ? `$${data.projected_monthly.toFixed(2)}` : 'Insufficient data';
}

function renderDailyChart(daily) {
    if (dailyChartInstance) dailyChartInstance.destroy();
    dailyChartInstance = safeChart('dailySpendChart', {
        type: 'bar',
        data: {
            labels: daily.map(d => d.date),
            datasets: [{
                label: 'Daily Spend ($)',
                data: daily.map(d => d.spend),
                backgroundColor: '#25d366',
                borderColor: '#128c4f',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true, title: { display: true, text: 'Spend ($)' } }
            },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(context) { return '$' + context.parsed.y.toFixed(2); } } } }
        }
    });
}

function renderPieChart(accounts) {
    if (pieChartInstance) pieChartInstance.destroy();
    const filtered = accounts.filter(a => a.total_spend > 0);
    const colors = ['#25d366','#0dcaf0','#ffc107','#dc3545','#fd7e14','#6c757d','#198754','#6f42c1','#d63384','#0d6efd'];
    pieChartInstance = safeChart('spendPieChart', {
        type: 'pie',
        data: {
            labels: filtered.map(a => a.account_name),
            datasets: [{
                data: filtered.map(a => a.total_spend),
                backgroundColor: colors.slice(0, filtered.length)
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function(context) { return context.label + ': $' + context.parsed.toFixed(2); } } } }
        }
    });
}

function renderCategoryChart(accounts) {
    if (categoryChartInstance) categoryChartInstance.destroy();
    const allCats = {};
    accounts.forEach(a => {
        Object.entries(a.categories).forEach(([cat, amount]) => {
            allCats[cat] = (allCats[cat] || 0) + amount;
        });
    });

    const sorted = Object.entries(allCats).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const colors = ['#25d366','#0dcaf0','#ffc107','#dc3545','#fd7e14','#6c757d','#198754','#6f42c1','#d63384','#0d6efd'];

    categoryChartInstance = safeChart('categoryChart', {
        type: 'bar',
        data: {
            labels: sorted.map(([cat]) => cat),
            datasets: [{
                label: 'Spend ($)',
                data: sorted.map(([, amount]) => amount),
                backgroundColor: colors.slice(0, sorted.length)
            }]
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(context) { return '$' + context.parsed.x.toFixed(2); } } } }
        }
    });
}

function renderTable(accounts) {
    document.getElementById('billingBody').innerHTML = accounts.map(a => `
        <tr>
            <td><strong>${escapeHtml(a.account_name)}</strong></td>
            <td style="font-size:0.8rem;color:#888">${escapeHtml(a.account_sid)}</td>
            <td><strong>$${a.total_spend.toFixed(2)}</strong></td>
            <td style="font-size:0.8rem">${Object.entries(a.categories).map(([c,v]) => `${escapeHtml(c)}: $${v.toFixed(2)}`).join('<br>')}</td>
        </tr>
    `).join('');
}

document.getElementById('exportBillingCSV')?.addEventListener('click', () => {
    const headers = ['Account Name', 'Account SID', 'Total Spend'];
    const rows = currentAccounts.map(a => [a.account_name, a.account_sid, a.total_spend.toFixed(2)]);
    exportCSV(csvFilename('billing'), headers, rows);
});
