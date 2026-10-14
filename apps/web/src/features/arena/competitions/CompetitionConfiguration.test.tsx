// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCatalog, MOCK_MAPS } from "./competitionTestFixtures";
import { CompetitionConfiguration } from "./CompetitionConfiguration";
import { CompetitionMapPreview } from "./CompetitionMapPreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CompetitionMapPreview", () => {
  it("renders 81 accessible readonly grid cells and labels pieces, seats, and goals", () => {
    const classicMap = MOCK_MAPS[0];
    render(<CompetitionMapPreview map={classicMap} />);

    // Must render exactly 81 cells for a 9x9 board
    const cells = screen.getAllByRole("gridcell");
    expect(cells).toHaveLength(81);

    // Goal cells
    const goalA = screen.getByTestId("map-cell-a1");
    expect(goalA).toHaveAttribute("aria-label", expect.stringMatching(/Ô a1:.*Đích Ghế A/i));

    const goalB = screen.getByTestId("map-cell-i9");
    expect(goalB).toHaveAttribute("aria-label", expect.stringMatching(/Ô i9:.*Đích Ghế B/i));

    // Inspect actual pieces from initial state
    // In classic: (4, 7) is e8 (file 4 = e, rank 7 = 8) -> Lá (Ghế A)
    const cellE8 = screen.getByTestId("map-cell-e8");
    expect(cellE8).toHaveAttribute("aria-label", expect.stringMatching(/Quân Lá.*Ghế A/i));

    // Seat B piece rotated: 8 - 4 = 4 (e), 8 - 7 = 1 (rank 2) -> e2 -> Lá (Ghế B)
    const cellE2 = screen.getByTestId("map-cell-e2");
    expect(cellE2).toHaveAttribute("aria-label", expect.stringMatching(/Quân Lá.*Ghế B/i));

    // Empty cell
    const cellB2 = screen.getByTestId("map-cell-b2");
    expect(cellB2).toHaveAttribute("aria-label", "Ô b2: Ô trống");

    // Header displaying map info and piece counts (10 A, 10 B)
    expect(screen.getByText(/Bản đồ: Cổ điển \(Classic\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Đỏ \(A\): 10/i)).toBeInTheDocument();
    expect(screen.getByText(/Xanh \(B\): 10/i)).toBeInTheDocument();
  });
});

describe("CompetitionConfiguration", () => {
  const catalog = createMockCatalog();

  describe("Edit mode", () => {
    it("renders native selects for format, map, and mode, and triggers change callbacks", () => {
      const onFormatChange = vi.fn();
      const onMapChange = vi.fn();
      const onModeChange = vi.fn();
      const onRoundCountChange = vi.fn();

      render(
        <CompetitionConfiguration
          mode="edit"
          catalog={catalog}
          formatId="double-round-robin"
          onFormatChange={onFormatChange}
          mapId="classic"
          onMapChange={onMapChange}
          competitionMode="ranked"
          onModeChange={onModeChange}
          roundCount=""
          onRoundCountChange={onRoundCountChange}
        />
      );

      // Format select
      const formatSelect = screen.getByRole("combobox", { name: /chọn thể thức thi đấu/i });
      expect(formatSelect).toHaveValue("double-round-robin");
      fireEvent.change(formatSelect, { target: { value: "single-round-robin" } });
      expect(onFormatChange).toHaveBeenCalledWith("single-round-robin");

      // Map select
      const mapSelect = screen.getByRole("combobox", { name: /chọn bản đồ xuất phát/i });
      expect(mapSelect).toHaveValue("classic");
      fireEvent.change(mapSelect, { target: { value: "flanks" } });
      expect(onMapChange).toHaveBeenCalledWith("flanks");

      // Mode select
      const modeSelect = screen.getByRole("combobox", { name: /chọn chế độ tính điểm/i });
      expect(modeSelect).toHaveValue("ranked");
      fireEvent.change(modeSelect, { target: { value: "practice" } });
      expect(onModeChange).toHaveBeenCalledWith("practice");

      // Map preview must be displayed
      expect(screen.getByTestId("map-preview-container")).toBeInTheDocument();
    });

    it("displays Swiss round count input and explanation when Swiss format is selected", () => {
      const onRoundCountChange = vi.fn();

      const { rerender } = render(
        <CompetitionConfiguration
          mode="edit"
          catalog={catalog}
          formatId="double-round-robin"
          onFormatChange={vi.fn()}
          mapId="classic"
          onMapChange={vi.fn()}
          competitionMode="ranked"
          onModeChange={vi.fn()}
          roundCount=""
          onRoundCountChange={onRoundCountChange}
        />
      );

      // Not visible in double round robin
      expect(screen.queryByLabelText(/số vòng thi đấu hệ thụy sĩ/i)).not.toBeInTheDocument();

      // Switch to Swiss
      rerender(
        <CompetitionConfiguration
          mode="edit"
          catalog={catalog}
          formatId="swiss"
          onFormatChange={vi.fn()}
          mapId="classic"
          onMapChange={vi.fn()}
          competitionMode="ranked"
          onModeChange={vi.fn()}
          roundCount={4}
          onRoundCountChange={onRoundCountChange}
        />
      );

      const swissInput = screen.getByLabelText(/số vòng thi đấu hệ thụy sĩ/i);
      expect(swissInput).toBeInTheDocument();
      expect(swissInput).toHaveValue(4);

      fireEvent.change(swissInput, { target: { value: "6" } });
      expect(onRoundCountChange).toHaveBeenCalledWith(6);
    });

    it("disables all inputs when disabled prop is true", () => {
      render(
        <CompetitionConfiguration
          mode="edit"
          catalog={catalog}
          formatId="swiss"
          onFormatChange={vi.fn()}
          mapId="classic"
          onMapChange={vi.fn()}
          competitionMode="ranked"
          onModeChange={vi.fn()}
          roundCount={3}
          onRoundCountChange={vi.fn()}
          disabled={true}
        />
      );

      expect(screen.getByRole("combobox", { name: /chọn thể thức thi đấu/i })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: /chọn bản đồ xuất phát/i })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: /chọn chế độ tính điểm/i })).toBeDisabled();
      expect(screen.getByLabelText(/số vòng thi đấu hệ thụy sĩ/i)).toBeDisabled();
    });

    it("renders empty state without inventing capabilities when catalog is null", () => {
      render(
        <CompetitionConfiguration
          mode="edit"
          catalog={null}
          formatId="classic"
          onFormatChange={vi.fn()}
          mapId="classic"
          onMapChange={vi.fn()}
          competitionMode="ranked"
          onModeChange={vi.fn()}
          roundCount=""
          onRoundCountChange={vi.fn()}
        />
      );

      expect(screen.getByTestId("configuration-no-catalog")).toHaveTextContent(
        "Chưa có dữ liệu danh mục thể thức & bản đồ từ máy chủ."
      );
    });
  });

  describe("View mode", () => {
    it("renders immutable configuration summary card and toggles map preview", () => {
      render(
        <CompetitionConfiguration
          mode="view"
          catalog={catalog}
          configuration={{
            formatId: "swiss",
            mapId: "flanks",
            mapRevision: 1,
            mode: "ranked",
            roundCount: 5,
            currentRound: 2,
          }}
        />
      );

      expect(screen.getByText("Cấu hình thể thức & Bản đồ")).toBeInTheDocument();
      expect(screen.getByText("Hệ Thụy Sĩ (Swiss System)")).toBeInTheDocument();
      expect(screen.getByText("Hai cánh (Flanks)")).toBeInTheDocument();
      expect(screen.getByText("(v1)")).toBeInTheDocument();
      expect(screen.getByText("Vòng 2 / 5")).toBeInTheDocument();
      expect(screen.getByText("Xếp hạng Elo")).toBeInTheDocument();

      // Initially map preview is collapsed
      expect(screen.queryByTestId("map-grid-table")).not.toBeInTheDocument();

      // Click button to show map preview
      const toggleBtn = screen.getByRole("button", { name: /xem bố cục bản đồ thi đấu/i });
      fireEvent.click(toggleBtn);

      expect(screen.getByTestId("map-grid-table")).toBeInTheDocument();
      expect(screen.getAllByRole("gridcell")).toHaveLength(81);
    });

    it("renders raw configuration and shows unavailable message if map data is missing in catalog", () => {
      render(
        <CompetitionConfiguration
          mode="view"
          catalog={null}
          configuration={{
            formatId: "custom-format",
            mapId: "custom-map",
            mapRevision: 1,
            mode: "practice",
            roundCount: 4,
          }}
        />
      );

      expect(screen.getByText("custom-format")).toBeInTheDocument();
      expect(screen.getByText("custom-map")).toBeInTheDocument();
      expect(screen.getByText("(v1)")).toBeInTheDocument();
      expect(screen.getByText("Tập luyện (Practice)")).toBeInTheDocument();

      const toggleBtn = screen.getByRole("button", { name: /xem bố cục bản đồ thi đấu/i });
      fireEvent.click(toggleBtn);

      expect(
        screen.getByText("Dữ liệu bố cục quân cờ của bản đồ này không khả dụng từ máy chủ.")
      ).toBeInTheDocument();
    });
  });
});
