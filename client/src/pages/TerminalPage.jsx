import TerminalTab from '../components/tabs/TerminalTab.jsx';

/** General server shell (no service attached) — starts at /var/www. */
export default function TerminalPage() {
  return (
    <div className="bg-grid-fade min-h-full">
      <header className="flex items-center px-8 h-14 border-b border-line sticky top-0 bg-bg/80 backdrop-blur z-10">
        <h1 className="text-[15px] font-semibold text-white">Terminal</h1>
      </header>
      <div className="p-8">
        <TerminalTab />
      </div>
    </div>
  );
}
