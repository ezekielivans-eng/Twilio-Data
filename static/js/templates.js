(async function() {
    showLoading();
    try {
        const res = await fetch(`/api/templates?${getDateParams()}`);
        const data = await res.json();
        renderTable(data.templates);
        renderRatesChart(data.templates);
        renderScatterChart(data.templates);
    } catch(e) {
        console.error('Failed to load templates:', e);
    }
    hideLoading();
})();

function renderTable(templates) {
    const tbody = document.getElementById('templatesBody');
    tbody.innerHTML = templates.map(t => `
        <tr>
            <td><strong>${t.template_name}</strong></td>
            <td>${t.total.toLocaleString()}</td>
            <td>${t.delivered.toLocaleString()}</td>
            <td>${t.read.toLocaleString()}</td>
            <td>${t.failed.toLocaleString()}</td>
            <td>${t.undelivered.toLocaleString()}</td>
            <td><span class="badge badge-success">${t.delivery_rate}%</span></td>
            <td><span class="badge badge-info">${t.read_rate}%</span></td>
            <td><span class="badge ${t.error_rate > 5 ? 'badge-danger' : 'badge-warning'}">${t.error_rate}%</span></td>
        </tr>
    `).join('');

    // Sorting
    document.querySelectorAll('#templatesTable thead th').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (!key) return;
            const sorted = [...templates].sort((a, b) => {
                if (typeof a[key] === 'string') return a[key].localeCompare(b[key]);
                return b[key] - a[key];
            });
            renderTable(sorted);
        });
    });
}

function renderRatesChart(templates) {
    const top = templates.slice(0, 10);
    new Chart(document.getElementById('ratesChart'), {
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
            scales: { y: { beginAtZero: true, max: 100 } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

function renderScatterChart(templates) {
    new Chart(document.getElementById('scatterChart'), {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Templates',
                data: templates.map(t => ({ x: t.total, y: t.delivery_rate, label: t.template_name })),
                backgroundColor: '#25d366',
                pointRadius: 6,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: { title: { display: true, text: 'Total Messages Sent' }, beginAtZero: true },
                y: { title: { display: true, text: 'Delivery Rate (%)' }, beginAtZero: true, max: 100 }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.raw.label}: ${ctx.raw.x} msgs, ${ctx.raw.y}% delivery`
                    }
                },
                legend: { display: false }
            }
        }
    });
}
