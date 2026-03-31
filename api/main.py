"""
FastAPI backend for next_ui containerlab integration.
"""

from typing import Dict, Any, List
from pathlib import Path
from fastapi import FastAPI, HTTPException, Depends, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
import os
import json
import threading
from datetime import datetime
import httpx
import yaml

from models.topology import (
    RuntimeLabState, ImageInfo, VersionInfo
)
from clab.api_client import create_api_client, ClabAPIClient

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


def get_api_client(request: Request) -> ClabAPIClient:
    """Dependency: create per-request ClabAPIClient from X-Clab-Server / X-Clab-Token headers."""
    server_url = request.headers.get("X-Clab-Server", "").strip() or os.getenv("CLAB_API_URL", "").strip()
    if not server_url:
        raise HTTPException(
            status_code=400,
            detail="Target clab API server is not configured. Provide X-Clab-Server header or set CLAB_API_URL.",
        )
    server_url = _normalize_server_url(server_url)
    token = request.headers.get("X-Clab-Token", "").strip() or os.getenv("CLAB_API_TOKEN") or None
    return create_api_client(base_url=server_url, auth_token=token)


def _normalize_server_url(server_url: str) -> str:
    url = (server_url or "").strip().rstrip("/")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="serverUrl must start with http:// or https://")
    return url


async def _parse_remote_response(resp: httpx.Response) -> Dict[str, Any]:
    content_type = resp.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            return {"content_type": content_type, "data": resp.json()}
        except Exception:
            return {"content_type": content_type, "data": resp.text}
    return {"content_type": content_type, "data": resp.text}


@app.post("/api/tester/login")
async def tester_login(payload: Dict[str, Any]):
    """Proxy login to remote containerlab API to avoid browser CORS issues."""
    server_url = _normalize_server_url(str(payload.get("serverUrl") or ""))
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")

    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password are required")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"{server_url}/login",
                json={"username": username, "password": password},
            )
        parsed = await _parse_remote_response(resp)
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=parsed.get("data"))
        return {
            "status": resp.status_code,
            "token": (parsed.get("data") or {}).get("token") if isinstance(parsed.get("data"), dict) else None,
            "response": parsed.get("data"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Login proxy failed: {e}")


@app.post("/api/tester/request")
async def tester_request(payload: Dict[str, Any]):
    """Generic proxy for API tester requests to remote containerlab API."""
    server_url = _normalize_server_url(str(payload.get("serverUrl") or ""))
    method = str(payload.get("method") or "GET").upper()
    endpoint = str(payload.get("endpoint") or "").strip()
    token = str(payload.get("token") or "").strip()
    body = payload.get("body")

    if not endpoint.startswith("/"):
        raise HTTPException(status_code=400, detail="endpoint must start with '/'")

    headers: Dict[str, str] = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            request_kwargs: Dict[str, Any] = {"headers": headers}
            if body is not None and method in {"POST", "PUT", "PATCH", "DELETE"}:
                request_kwargs["json"] = body
            resp = await client.request(method, f"{server_url}{endpoint}", **request_kwargs)

        parsed = await _parse_remote_response(resp)
        return {
            "status": resp.status_code,
            "content_type": parsed.get("content_type"),
            "data": parsed.get("data"),
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Request proxy failed: {e}")


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

@app.post("/api/clab/labs/deploy-yaml", response_model=RuntimeLabState)
async def deploy_lab_from_yaml(
    payload: Dict[str, Any],
    client: ClabAPIClient = Depends(get_api_client)
):
    """Deploy a new lab by sending containerlab YAML content directly to the API as topologyContent."""
    yaml_text = payload.get("yaml") if isinstance(payload, dict) else None
    if not isinstance(yaml_text, str) or not yaml_text.strip():
        raise HTTPException(status_code=400, detail="payload.yaml must be a non-empty string")

    try:
        yaml_content = yaml.safe_load(yaml_text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")

    if not isinstance(yaml_content, dict):
        raise HTTPException(status_code=400, detail="YAML root must be a mapping")
    if not yaml_content.get("name"):
        raise HTTPException(status_code=400, detail="YAML must include non-empty 'name'")

    try:
        runtime_lab = await client.deploy_lab_from_yaml(yaml_content)
        return runtime_lab
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/clab/labs")
async def list_labs(
    client: ClabAPIClient = Depends(get_api_client)
):
    """List all labs"""
    try:
        labs = await client.list_labs()
        return {"labs": labs}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to list labs: {e}")


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
    cleanup: bool = Query(False),
    client: ClabAPIClient = Depends(get_api_client)
):
    """Destroy a lab"""
    success = await client.destroy_lab(lab_id, cleanup=cleanup)
    if not success:
        raise HTTPException(status_code=404, detail=f"Lab {lab_id} not found")
    action = "destroyed and cleaned" if cleanup else "destroyed"
    return {"message": f"Lab {lab_id} {action}", "cleanup": cleanup}


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


@app.post("/api/clab/labs/{lab_id}/nodes/{node_name}/ssh")
async def request_node_ssh_access(
    lab_id: str,
    node_name: str,
    payload: Dict[str, Any],
    client: ClabAPIClient = Depends(get_api_client)
):
    """Request temporary SSH access to a node"""
    try:
        access = await client.request_node_ssh_access(lab_id, node_name, payload)
        return access
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
    return {"status": "ok"}


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
