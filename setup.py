"""
XylonStudio setup script.
"""

from setuptools import find_packages, setup

setup(
    name="xylonstudio",
    version="0.4.0",
    description="XylonStudio - reproducible local RTL verification",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="XylonStudio Team",
    author_email="hello@xylonstud.io",
    url="https://github.com/kevintseng/xylon-studio",
    license="MIT",
    packages=find_packages(
        exclude=(
            "agent.pipeline.tests",
            "agent.pipeline.tests.*",
            "agent.tests",
            "agent.tests.*",
        )
    ),
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
        "fastapi==0.141.1",
        "uvicorn[standard]==0.27.1",
        "pydantic==2.13.4",
    ],
)
