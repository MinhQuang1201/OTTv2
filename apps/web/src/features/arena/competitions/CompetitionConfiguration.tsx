import { useId, useMemo, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Badge } from "../../../shared/ui/Badge";
import { TextField } from "../../../shared/ui/TextField";
import { createDefaultCatalog } from "./catalogDefaults";
import { CompetitionMapPreview } from "./CompetitionMapPreview";
import type {
  CompetitionCatalogResponse,
  CompetitionConfig,
  CompetitionMode,
} from "./types";
import styles from "./competitions.module.css";

export interface CompetitionConfigurationEditProps {
  readonly mode: "edit";
  readonly catalog?: CompetitionCatalogResponse;
  readonly formatId: string;
  readonly onFormatChange: (formatId: string) => void;
  readonly mapId: string;
  readonly onMapChange: (mapId: string) => void;
  readonly competitionMode: CompetitionMode;
  readonly onModeChange: (mode: CompetitionMode) => void;
  readonly roundCount: number | "";
  readonly onRoundCountChange: (count: number | "") => void;
  readonly disabled?: boolean;
}

export interface CompetitionConfigurationViewProps {
  readonly mode: "view";
  readonly configuration: CompetitionConfig;
  readonly catalog?: CompetitionCatalogResponse;
}

export type CompetitionConfigurationProps =
  | CompetitionConfigurationEditProps
  | CompetitionConfigurationViewProps;

export function CompetitionConfiguration(props: CompetitionConfigurationProps) {
  const formatSelectId = useId();
  const mapSelectId = useId();
  const modeSelectId = useId();

  const [showMapModal, setShowMapModal] = useState(false);

  // Fallback to default catalog if not provided
  const catalog = props.catalog ?? createDefaultCatalog();

  if (props.mode === "view") {
    const config = props.configuration;
    const format = catalog.formats.find((f) => f.id === config.formatId) || {
      id: config.formatId,
      name: config.formatId,
      description: "",
    };
    const map = catalog.maps.find((m) => m.id === config.mapId) || {
      id: config.mapId,
      revision: config.mapRevision ?? 1,
      name: config.mapId,
      description: "",
    };

    return (
      <div className={styles.configCard} data-testid="competition-configuration-view">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h4 style={{ margin: 0, fontFamily: "var(--ui-font-display)", fontSize: "var(--ui-text-sm)", textTransform: "uppercase" }}>
            Cấu hình thể thức & Bản đồ
          </h4>
          <Badge status={config.mode === "ranked" ? "info" : "neutral"}>
            {config.mode === "ranked" ? "Xếp hạng Elo" : "Tập luyện (Practice)"}
          </Badge>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.5rem", marginTop: "0.25rem" }}>
          <div>
            <span style={{ fontSize: "var(--ui-text-xs)", color: "var(--ui-text-muted)" }}>Thể thức:</span>
            <div><strong>{format.name}</strong></div>
          </div>
          <div>
            <span style={{ fontSize: "var(--ui-text-xs)", color: "var(--ui-text-muted)" }}>Bản đồ thi đấu:</span>
            <div><strong>{map.name}</strong></div>
          </div>
          {config.roundCount ? (
            <div>
              <span style={{ fontSize: "var(--ui-text-xs)", color: "var(--ui-text-muted)" }}>Số vòng dự kiến:</span>
              <div>
                <strong>
                  {config.currentRound ? `Vòng ${config.currentRound} / ${config.roundCount}` : `${config.roundCount} vòng`}
                </strong>
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: "0.5rem" }}>
          <Button
            variant="secondary"
            onClick={() => setShowMapModal((prev) => !prev)}
            aria-expanded={showMapModal}
            aria-label="Xem bố cục bản đồ thi đấu"
          >
            {showMapModal ? "Ẩn bản đồ" : "Xem bố cục bản đồ 9x9"}
          </Button>
        </div>

        {showMapModal && (
          <div style={{ marginTop: "0.75rem" }}>
            <CompetitionMapPreview map={map} />
          </div>
        )}
      </div>
    );
  }

  // Edit mode
  const {
    formatId,
    onFormatChange,
    mapId,
    onMapChange,
    competitionMode,
    onModeChange,
    roundCount,
    onRoundCountChange,
    disabled = false,
  } = props;

  const selectedMap = useMemo(() => {
    return catalog.maps.find((m) => m.id === mapId) || catalog.maps[0];
  }, [catalog.maps, mapId]);

  const selectedFormat = useMemo(() => {
    return catalog.formats.find((f) => f.id === formatId) || catalog.formats[0];
  }, [catalog.formats, formatId]);

  const isSwiss = formatId === "swiss";

  return (
    <div className={styles.configSection} data-testid="competition-configuration-edit">
      <div className={styles.configGrid}>
        {/* Format Selector */}
        <div>
          <label htmlFor={formatSelectId} style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
            Thể thức thi đấu:
          </label>
          <select
            id={formatSelectId}
            className={styles.configSelect}
            value={formatId}
            onChange={(e) => onFormatChange(e.target.value)}
            disabled={disabled}
            aria-label="Chọn thể thức thi đấu"
          >
            {catalog.formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <small style={{ display: "block", marginTop: "4px", color: "var(--ui-text-muted)", fontSize: "var(--ui-text-xs)" }}>
            {selectedFormat.description}
          </small>
        </div>

        {/* Map Selector */}
        <div>
          <label htmlFor={mapSelectId} style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
            Bản đồ xuất phát (9x9):
          </label>
          <select
            id={mapSelectId}
            className={styles.configSelect}
            value={mapId}
            onChange={(e) => onMapChange(e.target.value)}
            disabled={disabled}
            aria-label="Chọn bản đồ xuất phát"
          >
            {catalog.maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <small style={{ display: "block", marginTop: "4px", color: "var(--ui-text-muted)", fontSize: "var(--ui-text-xs)" }}>
            {selectedMap.description}
          </small>
        </div>

        {/* Mode Selector */}
        <div>
          <label htmlFor={modeSelectId} style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
            Chế độ tính điểm:
          </label>
          <select
            id={modeSelectId}
            className={styles.configSelect}
            value={competitionMode}
            onChange={(e) => onModeChange(e.target.value as CompetitionMode)}
            disabled={disabled}
            aria-label="Chọn chế độ tính điểm"
          >
            {catalog.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <small style={{ display: "block", marginTop: "4px", color: "var(--ui-text-muted)", fontSize: "var(--ui-text-xs)" }}>
            {competitionMode === "ranked"
              ? "Tính điểm Elo chính thức cho bot sau giải đấu."
              : "Tập luyện/giao hữu, không ảnh hưởng đến điểm xếp hạng Elo."}
          </small>
        </div>
      </div>

      {/* Swiss Round Count Input */}
      {isSwiss && (
        <div style={{ padding: "var(--ui-space-3)", background: "rgba(33, 150, 243, 0.08)", border: "1px solid var(--ui-seat-b)" }}>
          <TextField
            label="Số vòng thi đấu Hệ Thụy Sĩ (Round Count: 1 - 32)"
            type="number"
            value={roundCount === "" ? "" : String(roundCount)}
            onChange={(e) => {
              const val = e.currentTarget.value.trim();
              if (val === "") {
                onRoundCountChange("");
              } else {
                const num = Number.parseInt(val, 10);
                if (!Number.isNaN(num)) {
                  onRoundCountChange(num);
                }
              }
            }}
            placeholder="Mặc định: 3 vòng"
            min="1"
            max="32"
            disabled={disabled}
          />
          <small style={{ display: "block", marginTop: "4px", color: "var(--ui-text-muted)", fontSize: "var(--ui-text-xs)" }}>
            Hệ Thụy Sĩ yêu cầu cấu hình số vòng đấu cụ thể (thường từ 1 đến N-1 vòng). Mỗi vòng đấu sẽ ghép cặp các bot có điểm số tương đồng.
          </small>
        </div>
      )}

      {/* Map Preview Accordion / Card */}
      <div style={{ marginTop: "0.5rem" }}>
        <CompetitionMapPreview map={selectedMap} />
      </div>
    </div>
  );
}
