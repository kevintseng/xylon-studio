"""
XylonStudio setup script.
"""

from setuptools import setup, find_packages

setup(
    name="xylonstudio",
    version="1.0.0",
    description="XylonStudio - AI-driven chip design platform",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="XylonStudio Team",
    author_email="hello@xylonstud.io",
    url="https://github.com/kevintseng/xylon-studio",
    license="MIT",
    packages=find_packages(where="agent"),
    package_dir={"": "agent"},
    python_requires=">=3.11",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Intended Audience :: Science/Research",
        "Topic :: Scientific/Engineering :: Electronic Design Automation (EDA)",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Operating System :: POSIX :: Linux",
        "Operating System :: MacOS",
    ],
    install_requires=[
        "fastapi>=0.110.0",
        "uvicorn[standard]>=0.27.1",
        "pydantic>=2.6.3",
        "pydantic-settings>=2.2.1",
        "openai>=1.13.3",
        "httpx>=0.27.0",
        "tenacity>=8.2.3",
        "python-dotenv>=1.0.1",
    ],
)
