import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './stylesheets/app.css';

const jobs = [
  { id: '024', name: 'Image processing', status: 'Running', providers: '3 / 3', cost: '0.008', date: 'Sep 28' },
  { id: '023', name: 'Simulation batch', status: 'Verifying', providers: '3 / 3', cost: '0.012', date: 'Sep 28' },
  { id: '022', name: 'Dataset analysis', status: 'Pending', providers: '0 / 3', cost: '0.006', date: 'Sep 28' },
  { id: '021', name: 'Matrix computation', status: 'Completed', providers: '3 / 3', cost: '0.004', date: 'Sep 27' },
  { id: '020', name: 'Render batch', status: 'Completed', providers: '3 / 3', cost: '0.010', date: 'Sep 27' },
];

const stats = {
  Buyer: [['Active jobs', '03'], ['Completed jobs', '12'], ['Total spent', '0.084', 'ETH']],
  Provider: [['Active jobs', '01'], ['Completed jobs', '18'], ['Total earned', '0.126', 'ETH']],
};

function App() {
  const [view, setView] = useState('Buyer');
  const isBuyer = view === 'Buyer';

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="Offbalance home">
            <svg width="28" height="30" viewBox="0 0 28 30" fill="none" aria-hidden="true">
              <path d="M3 8h8v20H3zM17 2h8v20h-8z" fill="currentColor" />
            </svg>
            offbalance<span className="brand-dot">.</span>
          </a>
          <div className="account"><span className="demo">Demo</span><span className="wallet">0x71C…9A2F</span></div>
        </div>
      </header>

      <main>
        <div className="page-heading">
          <h1>Overview</h1>
          <div className="view-switch" role="group" aria-label="Account view">
            {Object.keys(stats).map((role) => (
              <button key={role} aria-pressed={view === role} onClick={() => setView(role)}>{role}</button>
            ))}
          </div>
        </div>

        <section className="stats" aria-label={`${view} summary`}>
          {stats[view].map(([label, value, unit]) => (
            <div className="stat" key={label}>
              <h2>{label}</h2>
              <p>{value}{unit && <span className="unit">{unit}</span>}</p>
            </div>
          ))}
        </section>

        {!isBuyer && (
          <section className="machine" aria-label="Provider machine">
            <div className="machine-name"><span className="machine-icon" aria-hidden="true">▤</span><h2>My machine</h2><span className="status running">Online</span></div>
            <dl className="machine-specs">
              <div><dt>CPU score</dt><dd>8,420</dd></div>
              <div><dt>GPU score</dt><dd>12,680</dd></div>
              <div><dt>Memory score</dt><dd>6,240</dd></div>
              <div><dt>Stake</dt><dd>0.050 ETH</dd></div>
            </dl>
          </section>
        )}

        <section className="jobs" aria-labelledby="jobs-heading">
          <div className="section-heading"><h2 id="jobs-heading">{isBuyer ? 'Your jobs' : 'Assigned jobs'}</h2></div>
          <div className="table-scroll" role="region" aria-label="Jobs table" tabIndex="0">
            <table>
              <thead><tr><th>Job</th><th>Status</th><th>{isBuyer ? 'Providers' : 'Job ID'}</th><th>Submitted</th><th className="numeric">{isBuyer ? 'Budget' : 'Earnings'}</th></tr></thead>
              <tbody>
                {(isBuyer ? jobs : [jobs[0], jobs[3], jobs[4]]).map((job) => (
                  <tr key={job.id}>
                    <td><span className="job-symbol" aria-hidden="true">⌘</span><span className="job-name">{job.name}</span></td>
                    <td><span className={`status ${job.status.toLowerCase()}`}>{job.status}</span></td>
                    <td className="mono">{isBuyer ? job.providers : `#${job.id}`}</td>
                    <td className="date">{job.date}</td>
                    <td className="numeric mono">{isBuyer ? job.cost : job.status === 'Completed' ? '0.003' : '—'}<span className="currency"> ETH</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
