import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, formatDate, MachinesResponse } from "./api";

type MachineImage = {
  id: string;
  name: string;
  provider?: string;
  status?: string;
  created_at?: string;
  size_gb?: number;
  bootstrapped?: boolean;
  active?: boolean;
};

type ImagesResponse = {
  images: MachineImage[];
};

export function ImagesView({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [machineName, setMachineName] = useState("");
  const [imageName, setImageName] = useState("");
  const [notice, setNotice] = useState("");
  const images = useQuery({
    queryKey: ["images", token],
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
      setImageName("");
      setNotice(`Snapshot ${data.image?.name || "request"} accepted — it is being created and will appear in the list shortly.`);
      void queryClient.invalidateQueries({ queryKey: ["images", token] });
    },
  });
  const activate = useMutation({
    mutationFn: (image: MachineImage) => apiFetch("/v1/images/activate", token, {
      method: "POST",
      body: { provider: image.provider, id: image.id },
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["images", token] }),
  });
  const deleteImage = useMutation({
    mutationFn: (image: MachineImage) => apiFetch(
      `/v1/images/${encodeURIComponent(image.id)}?provider=${encodeURIComponent(image.provider || "")}`,
      token,
      { method: "DELETE" },
    ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["images", token] }),
  });
  const imageList = images.data?.images || [];
  const machineList = machines.data?.machines || [];

  function submitSnapshot(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    snapshot.mutate();
  }

  return (
    <section className="dashboard two-col">
      <aside className="rail rail-grid">
        <form className="create-form" onSubmit={submitSnapshot}>
          <div className="panel-heading small">
            <span>golden images</span>
            <h2>Snapshot a box</h2>
          </div>
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
          {notice ? <p className="hint">{notice}</p> : null}
        </form>
        <p className="hint">The active image is used for new boxes on that provider.</p>
      </aside>

      <div className="panel-stack">
        <div className="panel">
          <div className="panel-heading small">
            <span>admin</span>
            <h2>Images</h2>
          </div>
          {images.error ? <p className="error">{(images.error as Error).message}</p> : null}
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
                  <td>
                    {image.name}
                    {image.active ? <span className="badge">active</span> : null}
                  </td>
                  <td><code>{image.id || "-"}</code></td>
                  <td>{image.status || "-"}</td>
                  <td>{image.size_gb ? `${image.size_gb} GB` : "-"}</td>
                  <td>{formatDate(image.created_at)}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="primary-button"
                        type="button"
                        disabled={image.status !== "available" || image.active || activate.isPending}
                        onClick={() => activate.mutate(image)}
                      >
                        <Check size={14} />
                        Activate
                      </button>
                      <button
                        className="danger-button"
                        type="button"
                        disabled={image.active || deleteImage.isPending}
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
              <span>{images.isLoading ? "Loading images" : "No golden images yet. Snapshot one of your boxes to create one."}</span>
            </div>
          ) : null}
          {activate.error ? <p className="error">{(activate.error as Error).message}</p> : null}
          {deleteImage.error ? <p className="error">{(deleteImage.error as Error).message}</p> : null}
        </div>
      </div>
    </section>
  );
}
