import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, formatDate, ImagesResponse, MachineImage, MachinesResponse } from "./api";
import { useConsole } from "./console-context";
import { Drawer } from "./drawer";
import { WorkspaceHead } from "./shell";

export function ImagesView({ token }: { token: string }) {
  const { activeTeam } = useConsole();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [machineName, setMachineName] = useState("");
  const [imageName, setImageName] = useState("");
  const [notice, setNotice] = useState("");
  const activeTeamID = activeTeam?.id || "";
  const images = useQuery({
    queryKey: ["images", token, activeTeamID],
    queryFn: () => apiFetch<ImagesResponse>("/v1/images", token),
    refetchInterval: 30000,
  });
  const machines = useQuery({
    queryKey: ["machines", token],
    queryFn: () => apiFetch<MachinesResponse>("/v1/machines", token),
  });
  const snapshot = useMutation({
    mutationFn: () => apiFetch<{ image: MachineImage }>("/v1/images", token, {
      method: "POST",
      body: { machine: machineName, ...(imageName ? { name: imageName } : {}) },
    }),
    onSuccess: (data) => {
      setMachineName("");
      setImageName("");
      setAddOpen(false);
      setNotice(`Snapshot ${data.image?.name || "request"} accepted — it is being created and will appear in the list shortly.`);
      void queryClient.invalidateQueries({ queryKey: ["images", token, activeTeamID] });
    },
  });
  const deleteImage = useMutation({
    mutationFn: (image: MachineImage) => apiFetch(
      `/v1/images/${encodeURIComponent(image.id || image.name)}?provider=${encodeURIComponent(image.provider || "")}`,
      token,
      { method: "DELETE" },
    ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["images", token, activeTeamID] }),
  });
  const imageList = images.data?.images || [];
  const machineList = (machines.data?.machines || []).filter((machine) => !activeTeamID || (machine.team_id || machine.org_id) === activeTeamID);

  function submitSnapshot(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    snapshot.mutate();
  }

  return (
    <>
      <WorkspaceHead
        eyebrow={`team / ${activeTeam?.name || "Team"}`}
        title="Images"
        actions={(
          <button className="primary-button" type="button" onClick={() => setAddOpen(true)}>
            <Camera size={16} />
            Snapshot a box
          </button>
        )}
      />

      <div className="workspace-body">
        {notice ? <p className="hint">{notice}</p> : null}
        <div className="panel table-panel">
          {images.error ? <p className="error panel-error">{(images.error as Error).message}</p> : null}
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Name</th>
                <th>ID</th>
                <th>Status</th>
                <th>Size</th>
                <th>Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {imageList.map((image) => (
                <tr key={`${image.provider || "provider"}/${image.id || image.name}`}>
                  <td>{image.provider || "-"}</td>
                  <td>{image.name}</td>
                  <td><code>{image.id || "-"}</code></td>
                  <td>{image.status || "-"}</td>
                  <td>{image.size_gb ? `${image.size_gb} GB` : "-"}</td>
                  <td>{formatDate(image.created_at)}</td>
                  <td className="cell-actions">
                    <div className="table-actions">
                      <button
                        className="danger-button"
                        type="button"
                        disabled={!image.id || deleteImage.isPending}
                        title={!image.id ? "Wait until the provider finishes creating this image" : undefined}
                        onClick={() => {
                          if (window.confirm(`Delete image ${image.name}?`)) deleteImage.mutate(image);
                        }}
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!imageList.length ? (
            <div className="empty">
              <Camera size={20} />
              <span>{images.isLoading ? "Loading images" : "No images for this team yet. Snapshot one of this team's boxes to create one."}</span>
            </div>
          ) : null}
          {deleteImage.error ? <p className="error panel-error">{(deleteImage.error as Error).message}</p> : null}
        </div>
      </div>

      <Drawer open={addOpen} onClose={() => setAddOpen(false)} eyebrow="golden images" title="Snapshot a box">
        <form className="create-form" onSubmit={submitSnapshot}>
          <label>
            Machine
            <select value={machineName} onChange={(event) => setMachineName(event.target.value)} required>
              <option value="" disabled>Select a box</option>
              {machineList.map((machine) => (
                <option value={machine.name} key={machine.name}>{machine.name} ({machine.provider_label || machine.provider || "provider"})</option>
              ))}
            </select>
          </label>
          <label>
            Image name (optional)
            <input value={imageName} onChange={(event) => setImageName(event.target.value)} placeholder="dev-tools" />
          </label>
          <button className="primary-button" type="submit" disabled={snapshot.isPending || !machineName}>
            <Camera size={16} />
            {snapshot.isPending ? "Snapshotting" : "Create snapshot"}
          </button>
          {snapshot.error ? <p className="error">{(snapshot.error as Error).message}</p> : null}
          <p className="hint">Images belong to the active team and can be selected when creating a new box.</p>
        </form>
      </Drawer>
    </>
  );
}
