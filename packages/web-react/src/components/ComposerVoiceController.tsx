import { useEffect, useRef } from "react";
import { useVoiceInput, type VoiceState } from "../hooks/useVoiceInput";

export default function ComposerVoiceController({
  toggleNonce,
  getToken,
  onText,
  onError,
  onStateChange,
}: {
  toggleNonce: number;
  getToken?: () => string | null;
  onText: (text: string) => void;
  onError: (msg: string) => void;
  onStateChange: (state: VoiceState) => void;
}) {
  const voice = useVoiceInput({ getToken, onText, onError });
  const toggleRef = useRef(voice.toggle);
  toggleRef.current = voice.toggle;
  const handledNonceRef = useRef(0);

  useEffect(() => {
    onStateChange(voice.state);
  }, [voice.state, onStateChange]);

  useEffect(() => {
    if (toggleNonce === 0 || toggleNonce === handledNonceRef.current) return;
    handledNonceRef.current = toggleNonce;
    toggleRef.current();
  }, [toggleNonce]);

  return null;
}
