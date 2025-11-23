"""
Direct DNA Backend Import for API Gateway
Imports DNA backend functionality directly to avoid Docker networking issues
"""
import sys
import os
from typing import Dict, Any, Optional
import importlib.util

# Add DNA backend path to Python path for direct imports
# DNA backend is accessible at ./dna/experimental/spi/note_assistant_v2/backend inside the container
DNA_BACKEND_PATH = os.path.join(
    os.path.dirname(__file__), 
    'dna', 'experimental', 'spi', 'note_assistant_v2', 'backend'
)
DNA_BACKEND_PATH = os.path.abspath(DNA_BACKEND_PATH)

# Global variables for imported functions
get_available_models_endpoint = None
llm_summary = None
get_config = None
DNA_BACKEND_AVAILABLE = False

def initialize_dna_backend():
    """Initialize DNA backend imports with detailed error handling."""
    global get_available_models_endpoint, llm_summary, get_config, DNA_BACKEND_AVAILABLE
    
    if DNA_BACKEND_PATH not in sys.path:
        sys.path.insert(0, DNA_BACKEND_PATH)
    
    try:
        # Step 1: Import llm_service functions
        print(f"Attempting to import from: {DNA_BACKEND_PATH}")
        
        import llm_service
        get_available_models_endpoint = llm_service.get_available_models_endpoint
        llm_summary = llm_service.llm_summary
        print("Successfully imported llm_service functions")
        
        # Step 2: Import get_config from main.py using explicit loading
        dna_main_path = os.path.join(DNA_BACKEND_PATH, "main.py")
        if not os.path.exists(dna_main_path):
            raise FileNotFoundError(f"DNA backend main.py not found at: {dna_main_path}")
            
        spec = importlib.util.spec_from_file_location("dna_backend_main", dna_main_path)
        if spec is None:
            raise ImportError(f"Could not create module spec for: {dna_main_path}")
            
        dna_main_module = importlib.util.module_from_spec(spec)
        sys.modules["dna_backend_main"] = dna_main_module
        spec.loader.exec_module(dna_main_module)
        
        get_config = dna_main_module.get_config
        print("Successfully imported get_config from DNA backend main.py")
        
        DNA_BACKEND_AVAILABLE = True
        print(f"DNA backend initialization completed successfully")
        
    except Exception as e:
        print(f"Failed to initialize DNA backend: {e}")
        print(f"Error type: {type(e).__name__}")
        import traceback
        traceback.print_exc()
        DNA_BACKEND_AVAILABLE = False

# Initialize on module import
initialize_dna_backend()

class DNADirectIntegration:
    """Provides DNA backend functionality through direct imports."""
    
    def __init__(self):
        if not DNA_BACKEND_AVAILABLE:
            print("DNA backend not available - using fallback responses")
        else:
            print("DNA Direct Integration initialized successfully")
        
    async def get_available_models(self) -> Dict[str, Any]:
        """Get list of available LLM models."""
        if not DNA_BACKEND_AVAILABLE or get_available_models_endpoint is None:
            return {
                "available_models": [],
                "enabled_providers": [],
                "available_prompt_types": ["short"],
                "disable_llm": True,
                "error": "DNA backend not available"
            }
        
        try:
            # Call the DNA backend function directly
            return await get_available_models_endpoint()
        except Exception as e:
            print(f"Error calling DNA backend get_available_models_endpoint: {e}")
            return {
                "available_models": [],
                "enabled_providers": [],
                "available_prompt_types": ["short"],
                "disable_llm": True,
                "error": str(e)
            }
        
    async def llm_summary(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        """Generate LLM summary using DNA backend functionality."""
        if not DNA_BACKEND_AVAILABLE or llm_summary is None:
            return {
                "summary": "Error: DNA backend not available",
                "provider": "none",
                "model": "none",
                "prompt_type": "short",
                "routed": False,
                "error": True
            }
        
        try:
            # Call the DNA backend function directly
            return await llm_summary(request_data)
        except Exception as e:
            print(f"Error calling DNA backend llm_summary: {e}")
            return {
                "summary": f"Error: {str(e)}",
                "provider": "error",
                "model": "none", 
                "prompt_type": "short",
                "routed": False,
                "error": True
            }
    
    async def get_config(self) -> Dict[str, Any]:
        """Get DNA backend configuration."""
        if not DNA_BACKEND_AVAILABLE or get_config is None:
            return {
                "shotgrid_enabled": False,
                "vexa_routing_enabled": False,
                "llm_backend_routing_enabled": False,
                "integrated": True,
                "error": "DNA backend not available"
            }
        
        try:
            # Call the DNA backend function directly
            config_response = get_config()
            # get_config returns a JSONResponse, so we need to get the content
            if hasattr(config_response, 'content'):
                # JSONResponse.content is bytes, decode to string then parse as JSON
                import json
                return json.loads(config_response.content.decode('utf-8'))
            elif hasattr(config_response, 'body'):
                # Some FastAPI responses might have body attribute
                import json
                return json.loads(config_response.body.decode('utf-8'))
            else:
                # If it returns a dict directly, use it as-is
                return config_response
        except Exception as e:
            print(f"Error calling DNA backend get_config: {e}")
            return {
                "shotgrid_enabled": False,
                "vexa_routing_enabled": False,
                "llm_backend_routing_enabled": False,
                "integrated": True,
                "error": str(e)
            }

# Global instance
dna_direct_integration = DNADirectIntegration()
