(async function() {
    const cacheKey = `dashboard_${getDateParams()}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        const data = JSON.parse(cached);
        renderPage(data);
        return;
    }

    showLoading();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);
        const res = await fetch(`/api/dashboard?${getDateParams()}`, { signal: controller.signal });
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
})();

function renderPage(data) {
    renderKPIs(data.status_summary);
    renderStatusChart(data.status_summary);
    renderTimelineChart(data.daily);
    renderSubaccountsChart(data.top_subaccounts);
    renderTemplatesChart(data.top_templates);
    if (data.limit_reached) {
        showLimitWarning();
    }
    hideLoading();
}

function showLimitWarning() {
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
    new Chart(document.getElementById('statusChart'), {
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

    new Chart(document.getElementById('timelineChart'), {
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
    const top = subaccounts.slice(0, 8);
    new Chart(document.getElementById('subaccountsChart'), {
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
    const top = templates.slice(0, 8);
    new Chart(document.getElementById('templatesChart'), {
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
