from setuptools import setup, find_packages

setup(
    name="sag-intercept",
    version="0.1.0",
    description="SAG monkey-patch SDK — auto-intercepts OpenAI, Anthropic, and LangChain tool calls through the SAG gateway",
    author="SAG",
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[
        "requests>=2.28",
    ],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
    ],
)
