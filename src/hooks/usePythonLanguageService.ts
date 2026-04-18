import { useEffect, useRef } from "react";
import { TyLanguageService } from "../tyApi";

export function usePythonLanguageService(initialContent: string) {
  const serviceRef = useRef<TyLanguageService | null>(null);

  if (!serviceRef.current) {
    serviceRef.current = new TyLanguageService(initialContent);
  }

  useEffect(() => {
    if (!serviceRef.current) {
      serviceRef.current = new TyLanguageService(initialContent);
    }

    const service = serviceRef.current;

    return () => {
      service.dispose();
    };
  }, [initialContent]);

  return serviceRef.current;
}
