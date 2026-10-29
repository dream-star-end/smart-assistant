import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { SessionStatusDot } from "../src/components/SessionStatusDot";
import { useStopShortcut } from "../src/hooks/useStopShortcut";
import { deriveLiveTerminalFromMessages } from "../src/lib/sessionStatus";

function Harness() {
  const [running, setRunning] = useState(true);
  const [turn, setTurn] = useState(1);
  const [stops, setStops] = useState(0);
  const stop = () => { setStops((n) => n + 1); setRunning(false); };
  const liveTurn = useRef(turn);
  const dialog = useStopShortcut({ enabled: running, turnKey: `session:${turn}`, getStopAction: () => {
    const expected = liveTurn.current;
    return () => { if (liveTurn.current === expected) stop(); };
  } });
  (window as unknown as { nextTurn: () => void }).nextTurn = () => { liveTurn.current += 1; setTurn(liveTurn.current); setRunning(true); };
  (window as unknown as { replaceWithoutRender: () => void }).replaceWithoutRender = () => { liveTurn.current += 1; };
  const terminal = deriveLiveTerminalFromMessages([{ _errorCode: "USER_CANCELLED" }]);
  return <>
    <output data-testid="stops">{stops}</output>
    <output data-testid="turn">{turn}</output>
    <Composer busy={running} onStop={stop} onSend={() => {}} />
    <SessionStatusDot {...terminal!} />
    {dialog}
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
