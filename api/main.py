"""
FastAPI backend for next_ui containerlab integration.
Mode set to MOCK for frontend development when containerlab is unavailable.
"""

from typing import Dict, Any
from pathlib import Path
from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
import os
import json
import threading
from datetime import datetime

from models.topology import (
    TopologySpec, Node, Link, RuntimeLabState, ImageInfo, VersionInfo
)
from clab.api_client import create_api_client, APIMode, ClabAPIClient

# Create FastAPI app
app = FastAPI(
    title="next_ui Containerlab API",
    description="Backend for next_ui topology designer and containerlab orchestrator",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Add CORS middleware for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global API client (use mock mode by default)
_api_client: ClabAPIClient = None

# Project root directory (one level up from api/)
ROOT_DIR = Path(__file__).parent.parent
LAYOUT_STORE_FILE = ROOT_DIR / "clab" / "node_layouts.json"
_layout_lock = threading.Lock()


def _read_layout_store() -> Dict[str, Any]:
    if not LAYOUT_STORE_FILE.exists():
        return {}
    try:
        with LAYOUT_STORE_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_layout_store(data: Dict[str, Any]) -> None:
    LAYOUT_STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LAYOUT_STORE_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=True, indent=2)


def _get_layout_positions(lab_id: str) -> Dict[str, Any]:
    with _layout_lock:
        store = _read_layout_store()
        item = store.get(lab_id) or {}
        positions = item.get("positions")
        return positions if isinstance(positions, dict) else {}


def _set_layout_positions(lab_id: str, positions: Dict[str, Any]) -> Dict[str, Any]:
    with _layout_lock:
        store = _read_layout_store()
        store[lab_id] = {
            "positions": positions,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
        _write_layout_store(store)
    return store[lab_id]


def _delete_layout_positions(lab_id: str) -> bool:
    with _layout_lock:
        store = _read_layout_store()
        if lab_id not in store:
            return False
        del store[lab_id]
        _write_layout_store(store)
        return True


def get_api_client() -> ClabAPIClient:
    """Dependency: get global API client"""
    global _api_client
    if _api_client is None:
        # Use mock mode for frontend development
        use_mock = os.getenv("USE_MOCK_API", "true").lower() == "true"
        _api_client = create_api_client(use_mock=use_mock)
    return _api_client


# ============================================================================
# Image & Environment Endpoints
# ============================================================================

@app.get("/api/clab/images", response_model=list[ImageInfo])
async def list_images(
    client: ClabAPIClient = Depends(get_api_client)
):
    """List available container images"""
    return await client.get_images()


@app.get("/api/clab/version", response_model=VersionInfo)
async def get_version(
    client: ClabAPIClient = Depends(get_api_client)
):
    """Get clab-api-server and containerlab version"""
    return await client.get_version()


# ============================================================================
# Lab Lifecycle Endpoints
# ============================================================================

@app.post("/api/clab/labs", response_model=RuntimeLabState)
async def deploy_lab(
    topology: TopologySpec,
    client: ClabAPIClient = Depends(get_api_client)
):
    """Deploy a new lab from topology spec"""
    try:
        runtime_lab = await client.deploy_lab(topology)
        return runtime_lab
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/clab/labs")
async def list_labs(
    client: ClabAPIClient = Depends(get_api_client)
):
    """List all labs"""
    labs = await client.list_labs()
    return {"labs": labs}


@app.get("/api/clab/labs/{lab_id}", response_model=RuntimeLabState)
async def inspect_lab(
    lab_id: str,
    client: ClabAPIClient = Depends(get_api_client)
):
    """Get runtime state of specific lab"""
    runtime = await client.inspect_lab(lab_id)
    if not runtime:
        raise HTTPException(status_code=404, detail=f"Lab {lab_id} not found")
    return runtime


@app.delete("/api/clab/labs/{lab_id}")
async def destroy_lab(
    lab_id: str,
    client: ClabAPIClient = Depends(get_api_client)
):
    """Destroy a lab"""
    success = await client.destroy_lab(lab_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Lab {lab_id} not found")
    return {"message": f"Lab {lab_id} destroyed"}


# ============================================================================
# Node Control Endpoints
# ============================================================================

@app.post("/api/clab/labs/{lab_id}/nodes/{node_name}/exec")
async def exec_node_command(
    lab_id: str,
    node_name: str,
    command: Dict[str, str],
    client: ClabAPIClient = Depends(get_api_client)
):
    """Execute command on node"""
    try:
        output = await client.exec_node(lab_id, node_name, command.get("command", ""))
        return {"output": output}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/clab/labs/{lab_id}/nodes/{node_name}/save")
async def save_node_config(
    lab_id: str,
    node_name: str,
    client: ClabAPIClient = Depends(get_api_client)
):
    """Save config on node"""
    try:
        message = await client.save_node_config(lab_id, node_name)
        return {"message": message}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/clab/labs/{lab_id}/nodes/{node_name}/logs")
async def get_node_logs(
    lab_id: str,
    node_name: str,
    lines: int = Query(100, ge=1, le=1000),
    client: ClabAPIClient = Depends(get_api_client)
):
    """Get node logs"""
    try:
        logs = await client.get_node_logs(lab_id, node_name, lines)
        return {"logs": logs}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================================
# Graph/Topology Endpoints
# ============================================================================

@app.get("/api/clab/labs/{lab_id}/graph")
async def get_lab_graph(
    lab_id: str,
    client: ClabAPIClient = Depends(get_api_client)
):
    """Get lab topology graph (NeXt UI format)"""
    graph = await client.get_graph(lab_id)
    if not graph:
        raise HTTPException(status_code=404, detail=f"Graph for lab {lab_id} not found")
    return graph


@app.get("/api/clab/labs/{lab_id}/layout")
async def get_lab_layout(lab_id: str):
    """Get saved node positions for a lab"""
    return {
        "lab_id": lab_id,
        "positions": _get_layout_positions(lab_id),
    }


@app.put("/api/clab/labs/{lab_id}/layout")
async def put_lab_layout(lab_id: str, payload: Dict[str, Any]):
    """Save node positions for a lab"""
    positions = payload.get("positions") if isinstance(payload, dict) else None
    if not isinstance(positions, dict):
        raise HTTPException(status_code=400, detail="payload.positions must be an object")

    # Keep only finite numeric x/y values per node id.
    sanitized: Dict[str, Dict[str, float]] = {}
    for node_id, pos in positions.items():
        if not isinstance(node_id, str) or not isinstance(pos, dict):
            continue
        x = pos.get("x")
        y = pos.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            sanitized[node_id] = {"x": float(x), "y": float(y)}

    saved = _set_layout_positions(lab_id, sanitized)
    return {
        "lab_id": lab_id,
        "saved_count": len(saved.get("positions", {})),
        "updated_at": saved.get("updated_at"),
    }


@app.delete("/api/clab/labs/{lab_id}/layout")
async def delete_lab_layout(lab_id: str):
    """Delete saved node positions for a lab"""
    removed = _delete_layout_positions(lab_id)
    return {
        "lab_id": lab_id,
        "deleted": removed,
    }


# ============================================================================
# Health & Status
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "mode": "mock" if os.getenv("USE_MOCK_API", "true").lower() == "true" else "real"}


@app.get("/")
async def root():
    """Redirect to main UI"""
    return RedirectResponse(url="/main_api_v2.html")


# Mount static files AFTER all routes (order matters)
app.mount("/", StaticFiles(directory=str(ROOT_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    
    # Run with: uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
    uvicorn.run(app, host="0.0.0.0", port=8000)
