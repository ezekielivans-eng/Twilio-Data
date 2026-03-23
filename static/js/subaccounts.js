(async function() {
    const cacheKey = `subaccounts_${getDateParams()}`;
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
        const res = await fetch(`/api/subaccounts?${getDateParams()}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${res.status})`);
        }
        const data = await res.json();
        sessionStorage.setItem(cacheKey, JSON.stringify(data));
        renderPage(data);
    } catch(e) {
        showError(e.name === 'AbortError' ? 'Request timed out. Try a shorter date range.' : e.message);
    }
})();

function renderPage(data) {
    renderTable(data.subaccounts);
    renderSpendChart(data.subaccounts);
    hideLoading();
}

function renderTable(subaccounts) {
    const tbody = document.getElementById('subaccountsBody');
    tbody.innerHTML = subaccounts.map(a => `
        <tr class="clickable" onclick="window.location='/subaccounts/${a.sid}?${getDateParams()}'">
            <td><strong>${a.friendly_name}</strong>${a.limit_reached ? ' <span class="badge badge-warning" title="Message limit reached - totals approximate">~</span>' : ''}</td>
            <td>${a.total_messages.toLocaleString()}</td>
            <td>${a.delivered.toLocaleString()}</td>
            <td>${a.read.toLocaleString()}</td>
            <td>${a.failed.toLocaleString()}</td>
            <td><span class="badge badge-success">${a.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${a.read_rate}%</span></td>
            <td><span class="badge ${a.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${a.error_rate}%</span></td>
            <td>$${a.spend.toFixed(2)}</td>
        </tr>
    `).join('');

    // Sorting
    document.querySelectorAll('#subaccountsTable thead th').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (!key) return;
            const sorted = [...subaccounts].sort((a, b) => {
                if (typeof a[key] === 'string') return a[key].localeCompare(b[key]);
                return b[key] - a[key];
            });
            renderTable(sorted);
        });
    });
}

function renderSpendChart(subaccounts) {
    const top = subaccounts.filter(a => a.spend > 0).slice(0, 10);
    new Chart(document.getElementById('spendChart'), {
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
