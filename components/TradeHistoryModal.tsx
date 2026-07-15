import type { PaperTrade } from "@/lib/types";
import { Modal } from "./Modal";
import { TradeHistory } from "./TradeHistory";

export function TradeHistoryModal({
  trades,
  onClose,
}: {
  trades: PaperTrade[];
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} label="Paper trade history" className="max-w-2xl">
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-foreground hover:border-accent/50"
        >
          Close
        </button>
      </div>
      <TradeHistory trades={trades} />
    </Modal>
  );
}
