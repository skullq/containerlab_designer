"""
Mock/simulation server data for frontend development.
Provides realistic containerlab deployment scenarios without actual containers.
"""

from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from models.topology import (
    TopologySpec, Node, Link, RuntimeLabState, RuntimeNodeInfo,
    DeviceRole, LinkType, LinkState, LabState, MgmtNetwork, MgmtInfo,
    Interface, ImageInfo, VersionInfo
)


class MockClabServer:
    """
    Simulates clab-api-server responses for frontend development.
    Can generate multiple lab scenarios and track their state.
    """

    def __init__(self):
        self.labs: Dict[str, TopologySpec] = {}
        self.active_labs: Dict[str, RuntimeLabState] = {}
        self.images: List[ImageInfo] = self._init_images()
        self.version = VersionInfo(
            containerlab_version="0.52.0",
            api_server_version="1.0.0",
            capabilities=["deploy", "destroy", "list", "inspect", "exec", "save", "logs", "graph"]
        )

    def _init_images(self) -> List[ImageInfo]:
        """Initialize available mock images"""
        return [
            ImageInfo(
                repository="srl",
                tag="latest",
                image_id="sha256:srl_latest",
                size="500MB",
                created="2024-03-01",
                kind="nokia_srlinux"
            ),
            ImageInfo(
                repository="srl",
                tag="24.3.1",
                image_id="sha256:srl_24.3.1",
                size="500MB",
                created="2024-03-15",
                kind="nokia_srlinux"
            ),
            ImageInfo(
                repository="xrv",
                tag="latest",
                image_id="sha256:xrv_latest",
                size="700MB",
                created="2024-02-20",
                kind="vr-xrv"
            ),
            ImageInfo(
                repository="xrv",
                tag="7.8.1",
                image_id="sha256:xrv_7.8.1",
                size="700MB",
                created="2024-03-01",
                kind="vr-xrv"
            ),
            ImageInfo(
                repository="ceos",
                tag="4.31.0F",
                image_id="sha256:ceos_4.31.0F",
                size="800MB",
                created="2024-03-10",
                kind="ceos"
            ),
            ImageInfo(
                repository="linux",
                tag="ubuntu-latest",
                image_id="sha256:linux_ubuntu",
                size="200MB",
                created="2024-03-05",
                kind="linux"
            ),
        ]

    def get_images(self) -> List[ImageInfo]:
        """Mock: Image List API"""
        return self.images

    def get_version(self) -> VersionInfo:
        """Mock: Version Check API"""
        return self.version

    def create_sample_topology(self) -> TopologySpec:
        """Create a sample 3-node topology for demo"""
        lab = TopologySpec(
            lab_name="demo-lab",
            lab_id="demo-lab-001",
            mgmt_network=MgmtNetwork(
                name="clab-mgmt",
                ipv4_subnet="172.20.20.0/24"
            )
        )

        # Add three nodes
        nodes_config = [
            {
                "id": "core-rtr01",
                "name": "core-rtr01",
                "role": DeviceRole.CORE_ROUTER,
                "kind": "vr-xrv",
                "image": "xrv:7.8.1"
            },
            {
                "id": "core-rtr02",
                "name": "core-rtr02",
                "role": DeviceRole.CORE_ROUTER,
                "kind": "vr-xrv",
                "image": "xrv:7.8.1"
            },
            {
                "id": "dist-sw01",
                "name": "dist-sw01",
                "role": DeviceRole.DISTRIBUTION_SWITCH,
                "kind": "nokia_srlinux",
                "image": "srl:24.3.1"
            }
        ]

        for cfg in nodes_config:
            interfaces = [
                Interface(name="mgmt0", is_mgmt=True),
                Interface(name="eth1"),
                Interface(name="eth2"),
                Interface(name="eth3"),
            ]
            
            node = Node(
                id=cfg["id"],
                name=cfg["name"],
                role=cfg["role"],
                kind=cfg["kind"],
                image=cfg["image"],
                interfaces=interfaces,
                mgmt=MgmtInfo()
            )
            lab.nodes.append(node)

        # Add links
        links_config = [
            ("core-rtr01", "eth1", "core-rtr02", "eth1"),
            ("core-rtr01", "eth2", "dist-sw01", "eth1"),
            ("core-rtr02", "eth2", "dist-sw01", "eth2"),
        ]

        link_id = 0
        for src_node, src_if, dst_node, dst_if in links_config:
            link = Link(
                id=f"link-{link_id}",
                a_node=src_node,
                a_if=src_if,
                b_node=dst_node,
                b_if=dst_if,
                link_type=LinkType.P2P,
                state=LinkState.PLANNED,
                is_mgmt_excluded=True
            )
            lab.links.append(link)
            
            # Mark interfaces as used
            for node in lab.nodes:
                if node.id == src_node:
                    for iface in node.interfaces:
                        if iface.name == src_if:
                            iface.used = True
                            iface.linked_to = f"{dst_node}:{dst_if}"
                if node.id == dst_node:
                    for iface in node.interfaces:
                        if iface.name == dst_if:
                            iface.used = True
                            iface.linked_to = f"{src_node}:{src_if}"
            
            link_id += 1

        return lab

    def deploy_lab(self, topology: TopologySpec) -> RuntimeLabState:
        """Mock: Deploy API - create and track lab runtime state"""
        lab_id = topology.lab_id or f"lab-{datetime.now().strftime('%s')}"
        
        # Create runtime state with simulated container info
        runtime_nodes = []
        base_ip = 172
        base_ssh_port = 22000
        
        for idx, node in enumerate(topology.nodes):
            mgmt_ip = f"172.20.20.{10 + idx}"
            ssh_port = base_ssh_port + idx
            
            runtime_node = RuntimeNodeInfo(
                name=node.name,
                container_id=f"clab-{lab_id}-{node.name}",
                state="running",
                image=node.image,
                mgmt_ip=mgmt_ip,
                ssh_port=ssh_port,
                ssh_reachable=True
            )
            runtime_nodes.append(runtime_node)
            
            # Update topology node mgmt info
            node.mgmt.ipv4 = mgmt_ip
            node.mgmt.ssh_port = ssh_port
            node.mgmt.container_id = runtime_node.container_id

        runtime_lab = RuntimeLabState(
            lab_id=lab_id,
            lab_name=topology.lab_name,
            status=LabState.RUNNING,
            api_source="http://localhost:8000",
            nodes_runtime=runtime_nodes,
            deployed_at=datetime.now(timezone.utc),
            last_sync_at=datetime.now(timezone.utc)
        )

        self.active_labs[lab_id] = runtime_lab
        self.labs[lab_id] = topology
        
        return runtime_lab

    def list_labs(self) -> List[Dict]:
        """Mock: List API - return all active labs"""
        return [
            {
                "name": lab.lab_name,
                "id": lab_id,
                "status": runtime.status,
                "nodes_count": len(runtime.nodes_runtime),
                "deployed_at": runtime.deployed_at.isoformat() if runtime.deployed_at else None
            }
            for lab_id, runtime in self.active_labs.items()
        ]

    def inspect_lab(self, lab_id: str) -> Optional[RuntimeLabState]:
        """Mock: Inspect API - return runtime inventory for specific lab"""
        return self.active_labs.get(lab_id)

    def destroy_lab(self, lab_id: str) -> bool:
        """Mock: Destroy API - stop and remove lab"""
        if lab_id in self.active_labs:
            self.active_labs[lab_id].status = LabState.DESTROYED
            del self.active_labs[lab_id]
            return True
        return False

    def exec_node(self, lab_id: str, node_name: str, command: str) -> str:
        """Mock: Exec API - simulate command execution on node"""
        # Simulate some realistic outputs
        outputs = {
            "show ip interface brief": """Interface       IP-Address      Status
eth1            10.0.0.1        up
eth2            10.0.0.5        up
eth3            unassigned      down
mgmt0           172.20.20.10    up""",
            "show running-config | include interface": """interface eth1
  ip address 10.0.0.1 255.255.255.0
interface eth2
  ip address 10.0.0.5 255.255.255.0""",
            "show ospf neighbor": """Neighbor ID     Pri   State           Dead Time   Address         Interface
1.1.1.2         1     FULL/DR         35s         10.0.0.5        eth2""",
            "show version": """Cisco IOS XR Software, Version 7.8.1
System uptime is 2 hours 15 minutes"""
        }
        
        # Return realistic output or command echo
        for cmd_key, output in outputs.items():
            if cmd_key.lower() in command.lower():
                return output
        
        return f"$ {command}\n[Output simulated for development]"

    def save_node_config(self, lab_id: str, node_name: str) -> str:
        """Mock: Save API - simulate config save"""
        return f"Config saved for {node_name} in lab {lab_id}"

    def get_node_logs(self, lab_id: str, node_name: str, lines: int = 100) -> str:
        """Mock: Logs API - simulate node logs"""
        logs = [
            f"[{datetime.now() - timedelta(minutes=i)} UTC] System boot message {i}"
            for i in range(lines)
        ]
        return "\n".join(logs)

    def get_graph(self, lab_id: str) -> Dict:
        """Mock: Graph API - return topology graph data in NeXt UI format"""
        runtime_lab = self.active_labs.get(lab_id)
        if not runtime_lab:
            return {}
        
        # Get topology spec
        topology = self.labs.get(lab_id)
        if not topology:
            return {}
        
        # Convert to NeXt UI topology format
        nodes = []
        links = []
        
        for node in topology.nodes:
            nodes.append({
                "id": node.id,
                "name": node.name,
                "primaryIP": node.mgmt.ipv4 if node.mgmt else None,
                "model": node.kind,
                "icon": self._get_icon_for_kind(node.kind),
                "layerSortPreference": self._get_layer_preference(node.role),
                "state": "running",
                "kind": node.kind
            })
        
        for link in topology.links:
            links.append({
                "id": link.id,
                "source": link.a_node,
                "target": link.b_node,
                "srcIfName": link.a_if,
                "tgtIfName": link.b_if,
                "srcDevice": link.a_node,
                "tgtDevice": link.b_node,
                "state": link.state,
                "is_mgmt_excluded": link.is_mgmt_excluded
            })
        
        return {
            "nodes": nodes,
            "links": links
        }

    def _get_icon_for_kind(self, kind: str) -> str:
        """Map containerlab kind to icon type"""
        icon_map = {
            "nokia_srlinux": "switch",
            "vr-xrv": "router",
            "ceos": "switch",
            "linux": "host",
            "default": "unknown"
        }
        return icon_map.get(kind, "unknown")

    def _get_layer_preference(self, role: DeviceRole) -> int:
        """Get layer sort preference from role"""
        layer_map = {
            DeviceRole.UNDEFINED: 1,
            DeviceRole.OUTSIDE: 2,
            DeviceRole.EDGE_SWITCH: 3,
            DeviceRole.EDGE_ROUTER: 4,
            DeviceRole.CORE_ROUTER: 5,
            DeviceRole.CORE_SWITCH: 6,
            DeviceRole.DISTRIBUTION_ROUTER: 7,
            DeviceRole.DISTRIBUTION_SWITCH: 8,
            DeviceRole.LEAF: 9,
            DeviceRole.SPINE: 10,
            DeviceRole.ACCESS_SWITCH: 11,
        }
        return layer_map.get(role, 1)


# Global singleton for mock server
_mock_server: Optional[MockClabServer] = None


def get_mock_server() -> MockClabServer:
    """Get or create global mock server instance"""
    global _mock_server
    if _mock_server is None:
        _mock_server = MockClabServer()
    return _mock_server
